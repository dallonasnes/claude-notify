#!/usr/bin/env node

const pty = require('node-pty');
const axios = require('axios');
const { program } = require('commander');
const fs = require('fs');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const ngrok = require('@ngrok/ngrok');

// Parse CLI arguments
program
  .name('claude-notify')
  .description('Transparent wrapper for Claude CLI that sends Slack notifications when Claude is waiting for input.\n\n' +
    'This is an unofficial wrapper tool, not affiliated with Claude or Anthropic.\n' +
    'It transparently passes all arguments to the claude command.')
  .version('1.0.0')
  .option('-t, --timeout <ms>', 'idle timeout in milliseconds before sending notification', '15000')
  .option('-w, --webhook-url <url>', 'Slack webhook URL for notifications')
  .option('--disable-notifications', 'run without notifications (transparent pass-through only)')
  .option('-d, --debug', 'enable debug mode with state transition logging')
  .option('--ngrok-domain <domain>', 'Static ngrok domain for webhook server')
  .allowUnknownOption(true)
  .parse();

const options = program.opts();

// Configuration
const NOTIFICATION_TIMEOUT = parseInt(options.timeout);
const SLACK_WEBHOOK_URL = options.webhookUrl || process.env.SLACK_WEBHOOK_URL;
const NOTIFICATIONS_DISABLED = options.disableNotifications;
const DEBUG_MODE = options.debug;
const NGROK_DOMAIN = options.ngrokDomain || process.env.NGROK_DOMAIN;

// Audit logging setup
const AUDIT_LOG_FILE = path.join(process.cwd(), 'claude-notify-audit.log');
const DATA_DEBUG_LOG_FILE = path.join(process.cwd(), 'claude-notify-data-debug.log');
const auditLog = [];

function logStateTransition(event, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    event,
    state: {
      currentState,
      userHasEngaged,
      notificationSent,
      isClaudeWorking,
      timers: {
        notificationTimer: !!notificationTimer
      },
      bufferChunks: claudeDataChunks.length
    },
    context,
    decision: null
  };

  auditLog.push(entry);

  // Write to audit file only in debug mode
  if (DEBUG_MODE) {
    fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify(entry) + '\n');
  }

  return entry;
}

function logDataDebug(data, containsInterruptText, decision, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    dataLength: data.length,
    containsInterruptText,
    decision,
    currentState,
    rawData: data.toString(),
    cleanedData: data.toString().replace(/\x1b\[[0-9;]*m/g, ''),
    hexPreview: data.toString('hex').substring(0, 40),
    context
  };

  // Always write data debug logs when in debug mode
  if (DEBUG_MODE) {
    fs.appendFileSync(DATA_DEBUG_LOG_FILE, JSON.stringify(entry) + '\n');
  }

  return entry;
}

// State variables
let userHasEngaged = false;
let notificationSent = false;
let isClaudeWorking = false;
let notificationTimer = null;
let currentState = 'IDLE'; // IDLE, WORKING, WAITING, NOTIFIED
let claudeDataChunks = []; // Store Claude output chunks for performance

// Initialize audit log
logStateTransition('SESSION_STARTED', {
  config: {
    notificationTimeout: NOTIFICATION_TIMEOUT,
    notificationsEnabled: !NOTIFICATIONS_DISABLED,
    hasWebhook: !!SLACK_WEBHOOK_URL
  }
});

// Get arguments for Claude
const claudeArgs = program.args;

// Global variables for server integration
let claude = null;
let ngrokUrl = null;

// Validate configuration
if (!NOTIFICATIONS_DISABLED && (!SLACK_WEBHOOK_URL || !NGROK_DOMAIN)) {
  console.error('Error: Both SLACK_WEBHOOK_URL and NGROK_DOMAIN are required when notifications are enabled.');
  console.error('Set SLACK_WEBHOOK_URL environment variable or use --webhook-url option.');
  console.error('Set NGROK_DOMAIN environment variable or use --ngrok-domain option.');
  console.error('Use --disable-notifications to run without notifications.');
  process.exit(1);
}

// State transition functions
function transitionToState(newState, trigger, context = {}) {
  const oldState = currentState;
  currentState = newState;

  logStateTransition('STATE_TRANSITION', {
    from: oldState,
    to: newState,
    trigger,
    ...context
  });
}

function transitionToWorking(trigger) {
  if (currentState !== 'WORKING') {
    isClaudeWorking = true;
    clearAllTimers('entered_working_state');
    transitionToState('WORKING', trigger);
  }
}

function transitionToWaiting(trigger) {
  if (currentState !== 'WAITING') {
    isClaudeWorking = false;
    transitionToState('WAITING', trigger);

    // Start notification timer only on state transition
    if (shouldStartNotificationTimer()) {
      logStateTransition('NOTIFICATION_TIMER_STARTED', { timeoutMs: NOTIFICATION_TIMEOUT });
      notificationTimer = setTimeout(() => {
        logStateTransition('NOTIFICATION_TIMER_EXPIRED');
        notificationTimer = null;

        if (shouldSendNotification()) {
          sendSlackNotification();
          notificationSent = true;
          transitionToState('NOTIFIED', 'notification_sent');
        }
      }, NOTIFICATION_TIMEOUT);
    }
  }
}

function shouldSendNotification() {
  const entry = logStateTransition('NOTIFICATION_EVALUATION', {
    conditions: {
      userHasEngaged,
      notificationNotSent: !notificationSent,
      claudeNotWorking: !isClaudeWorking,
      notificationsEnabled: !NOTIFICATIONS_DISABLED
    }
  });

  const decision = userHasEngaged && !notificationSent && !isClaudeWorking && !NOTIFICATIONS_DISABLED;
  entry.decision = decision ? 'SEND_NOTIFICATION' : 'SKIP_NOTIFICATION';
  entry.context.reason = decision ? 'all_conditions_met' : getSkipReason();

  return decision;
}

function getSkipReason() {
  if (!userHasEngaged) return 'user_not_engaged';
  if (notificationSent) return 'notification_already_sent';
  if (isClaudeWorking) return 'claude_still_working';
  if (NOTIFICATIONS_DISABLED) return 'notifications_disabled';
  return 'unknown';
}

function shouldStartNotificationTimer() {
  const entry = logStateTransition('NOTIFICATION_TIMER_EVALUATION', {
    currentState,
    claudeNotWorking: !isClaudeWorking,
    noNotificationTimer: !notificationTimer,
    userEngaged: userHasEngaged
  });

  const decision = currentState === 'WAITING' && !notificationTimer;
  entry.decision = decision ? 'START_TIMER' : 'SKIP_TIMER';
  entry.context.reason = decision ? 'conditions_met' : 'not_in_waiting_state_or_timer_active';

  return decision;
}

function clearAllTimers(reason) {
  if (notificationTimer) {
    clearTimeout(notificationTimer);
    notificationTimer = null;
    logStateTransition('NOTIFICATION_TIMER_CLEARED', { reason });
  }
}

// HTTP Server Setup
async function setupWebhookServer() {
  if (!NGROK_DOMAIN) {
    logStateTransition('WEBHOOK_SERVER_SKIPPED', {
      reason: 'missing_ngrok_domain',
      hasNgrokDomain: !!NGROK_DOMAIN
    });
    return null;
  }

  const app = express();
  app.use(bodyParser.json());

  // Webhook endpoint for Slack events
  app.post('/webhook', (req, res) => {
    logStateTransition('WEBHOOK_REQUEST_RECEIVED', {
      type: req.body.type,
      hasEvent: !!req.body.event
    });

    // Handle Slack's URL verification challenge
    if (req.body.type === 'url_verification') {
      logStateTransition('URL_VERIFICATION_CHALLENGE', { challenge: req.body.challenge });
      return res.send(req.body.challenge);
    }

    // Process actual events
    if (req.body.type === 'event_callback' && req.body.event) {
      const event = req.body.event;

      // Only process message events
      if (event.type === 'message' && event.text && !event.bot_id) {
        logStateTransition('SLACK_MESSAGE_RECEIVED', {
          text: event.text,
          user: event.user,
          channel: event.channel
        });

        // Send message to Claude's stdin
        if (claude) {
          claude.write(event.text + '\n');
          logStateTransition('MESSAGE_SENT_TO_CLAUDE', { text: event.text });

          // Reset notification state when user responds via Slack
          clearAllTimers('slack_message_received');
          notificationSent = false;
          userHasEngaged = true;

          if (currentState === 'NOTIFIED') {
            transitionToState('WAITING', 'slack_message_received');
          }
        }
      }
    }

    res.sendStatus(200);
  });

  // Start server on random port
  const server = app.listen(0, () => {
    const port = server.address().port;
    logStateTransition('WEBHOOK_SERVER_STARTED', { port });
  });

  return server;
}

// Start ngrok tunnel
async function startNgrokTunnel(port) {
  try {
    logStateTransition('NGROK_TUNNEL_STARTING', { domain: NGROK_DOMAIN, port });

    const listener = await ngrok.forward({
      addr: port,
      domain: NGROK_DOMAIN,
      authtoken_from_env: true
    });

    ngrokUrl = listener.url();
    logStateTransition('NGROK_TUNNEL_STARTED', { url: ngrokUrl });

    return listener;
  } catch (error) {
    logStateTransition('NGROK_TUNNEL_FAILED', { error: error.message });
    throw error;
  }
}

// Find the claude binary path
function findClaudeBinary() {
  // Try to use the bundled claude first
  try {
    const bundledPath = path.resolve(__dirname, '../node_modules/.bin/claude');
    if (fs.existsSync(bundledPath)) {
      return bundledPath;
    }
  } catch (e) {
    // Fall through to global claude
  }

  // Fall back to global claude command
  return 'claude';
}

// Main startup function
async function startClaudeNotify() {
  try {
    // Setup webhook server and ngrok if configured
    let webhookServer = null;
    let ngrokListener = null;

    if (NGROK_DOMAIN) {
      webhookServer = await setupWebhookServer();
      if (webhookServer) {
        const port = webhookServer.address().port;
        ngrokListener = await startNgrokTunnel(port);
      }
    }

    // Spawn claude subprocess with PTY
    const claudeBinary = findClaudeBinary();
    claude = pty.spawn(claudeBinary, claudeArgs, {
      name: 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '1', TERM: 'xterm-256color' }
    });

    // Setup Claude event handlers
    setupClaudeHandlers(webhookServer, ngrokListener);

  } catch (error) {
    logStateTransition('STARTUP_FAILED', { error: error.message });
    console.error('Failed to start claude-notify:', error.message);
    process.exit(1);
  }
}

function setupClaudeHandlers(webhookServer, ngrokListener) {
  // Handle spawn errors
  claude.on('error', (error) => {
    logStateTransition('CLAUDE_SPAWN_ERROR', { error: error.message });
    cleanup(webhookServer, ngrokListener);
    process.exit(1);
  });

  // Monitor Claude's output
  claude.onData((data) => {
    process.stdout.write(data);

    // Accumulate Claude output for task-based notifications
    claudeDataChunks.push(data);

    const containsInterruptText = data.includes('to interrupt)');

    // Log detailed data analysis for debugging
    let stateDecision = 'NO_CHANGE';
    if (containsInterruptText && currentState !== 'WORKING') {
      stateDecision = 'TRANSITION_TO_WORKING';
    } else if (!containsInterruptText && currentState === 'WORKING') {
      stateDecision = 'TRANSITION_TO_WAITING';
    } else if (!containsInterruptText && currentState === 'IDLE') {
      stateDecision = 'REMAIN_IDLE';
    } else if (!containsInterruptText && (currentState === 'WAITING' || currentState === 'NOTIFIED')) {
      stateDecision = 'OUTPUT_WHILE_WAITING';
    }

    logDataDebug(data, containsInterruptText, stateDecision, {
      previousState: currentState,
      totalChunks: claudeDataChunks.length
    });

    logStateTransition('CLAUDE_OUTPUT_RECEIVED', {
      dataLength: data.length,
      containsInterruptText,
      currentState,
      totalChunks: claudeDataChunks.length,
      cleanedPreview: data.toString().replace(/\x1b\[[0-9;]*m/g, '').substring(0, 100)
    });

    // State machine logic - only Claude's output drives state transitions
    if (containsInterruptText && currentState !== 'WORKING') {
      // First time seeing "to interrupt)" - Claude started working
      transitionToWorking('interrupt_text_appeared');
    } else if (!containsInterruptText && currentState === 'WORKING') {
      // "to interrupt)" disappeared - Claude needs interaction
      transitionToWaiting('interrupt_text_disappeared');
    } else if (!containsInterruptText && currentState === 'IDLE') {
      // Still in startup - Claude hasn't needed interaction yet
      logStateTransition('REMAINING_IN_IDLE', { reason: 'startup_output_no_interrupt_text' });
    } else if (!containsInterruptText && (currentState === 'WAITING' || currentState === 'NOTIFIED')) {
      // Additional output while waiting - stay in current state, don't restart timers
      logStateTransition('OUTPUT_WHILE_WAITING', {
        reason: 'claude_output_in_waiting_state',
        currentState
      });
    }
    // All other cases: stay in current state without logging
  });

  // Set up raw mode for proper terminal input handling
  process.stdin.setRawMode(true);

  // Forward stdin directly to claude
  process.stdin.on('data', (data) => {
    claude.write(data);

    const isEnterKey = data.includes('\r') || data.includes('\n');
    const previousUserHasEngaged = userHasEngaged;
    const previousNotificationSent = notificationSent;

    logStateTransition('USER_INPUT_RECEIVED', {
      dataLength: data.length,
      isEnterKey,
      currentState,
      keyPreview: data.toString('hex').substring(0, 20)
    });

    // Always clear notification timer when user types (shows awareness)
    clearAllTimers('user_input_received');
    notificationSent = false;

    // Reset Claude data buffer when user submits input (Enter key)
    if (isEnterKey) {
      logStateTransition('CLAUDE_DATA_BUFFER_RESET', {
        previousChunks: claudeDataChunks.length,
        trigger: 'user_submit_input'
      });
      claudeDataChunks = [];
    }

    if (notificationSent !== previousNotificationSent) {
      logStateTransition('NOTIFICATION_STATE_RESET', {
        from: previousNotificationSent,
        to: notificationSent,
        trigger: 'user_input'
      });
    }

    // Mark user as engaged when they submit input (Enter key)
    if (isEnterKey && !userHasEngaged) {
      userHasEngaged = true;
      logStateTransition('USER_ENGAGEMENT_CHANGED', {
        from: previousUserHasEngaged,
        to: userHasEngaged,
        trigger: 'first_message_submitted'
      });
    }

    // Handle state transitions - user input resets us from NOTIFIED back to WAITING
    if (currentState === 'NOTIFIED') {
      transitionToState('WAITING', 'user_input_after_notification');
    }
  });

  // Handle claude exit
  claude.onExit(({ exitCode }) => {
    logStateTransition('CLAUDE_EXITED', { exitCode });
    cleanup(webhookServer, ngrokListener);
    process.exit(exitCode);
  });

  // Resume stdin
  process.stdin.resume();
}

// Send Slack notification
async function sendSlackNotification() {
  logStateTransition('SLACK_NOTIFICATION_ATTEMPT');

  if (NOTIFICATIONS_DISABLED) {
    logStateTransition('SLACK_NOTIFICATION_SKIPPED', { reason: 'notifications_disabled' });
    return;
  }

  if (!SLACK_WEBHOOK_URL) {
    logStateTransition('SLACK_NOTIFICATION_FAILED', { reason: 'no_webhook_url' });
    // Silently fail - no console output
    return;
  }

  try {
    const sessionId = process.pid;
    const cwd = process.cwd();

    // Extract the last task from Claude's output
    const fullBuffer = claudeDataChunks.join('');
    const tasks = fullBuffer.split('●');
    const lastTask = tasks.length > 1 ? tasks[tasks.length - 1] : fullBuffer;

    // Clean up the task content
    let cleanedTask = lastTask.replace(/\x1b\[[0-9;]*m/g, ''); // Remove ANSI escape codes

    // Filter out UI lines: remove lines starting with ✻ and ending with "to interrupt)" plus everything below
    const lines = cleanedTask.split('\n');
    const filteredLines = [];

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.includes('esc to interrupt')) {
        break;
      }
      filteredLines.push(line);
    }

    cleanedTask = filteredLines.join('\n').trim().substring(0, 1000);

    const messageText = cleanedTask.length > 0
      ? `Claude completed a task`
      : `Claude is waiting for your input`;

    const payload = {
      text: messageText,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🤖 *${messageText}*`
          }
        }
      ]
    };

    // Add webhook response option if ngrok is available
    if (ngrokUrl) {
      payload.blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `💬 Reply in this channel to send a message to Claude`
        }
      });
    }

    // Add task content if available
    if (cleanedTask.length > 0) {
      payload.blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `\`\`\`${cleanedTask}\`\`\``
        }
      });
    }

    // Add context footer
    payload.blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Session ID: ${sessionId} | Directory: \`${cwd}\``
        }
      ]
    });

    logStateTransition('SLACK_NOTIFICATION_PAYLOAD_PREPARED', {
      taskContentLength: cleanedTask.length,
      totalChunks: claudeDataChunks.length,
      totalTasks: tasks.length
    });

    await axios.post(SLACK_WEBHOOK_URL, payload);
    logStateTransition('SLACK_NOTIFICATION_SUCCESS');
  } catch (error) {
    logStateTransition('SLACK_NOTIFICATION_FAILED', {
      error: error.message,
      reason: 'api_error'
    });
    // Silently fail - no console output
  }
}

// Cleanup function
function cleanup(webhookServer, ngrokListener) {
  logStateTransition('CLEANUP_STARTED');
  clearAllTimers('cleanup');

  // Close webhook server
  if (webhookServer) {
    webhookServer.close(() => {
      logStateTransition('WEBHOOK_SERVER_CLOSED');
    });
  }

  // Close ngrok tunnel
  if (ngrokListener) {
    ngrokListener.close().then(() => {
      logStateTransition('NGROK_TUNNEL_CLOSED');
    }).catch(err => {
      logStateTransition('NGROK_TUNNEL_CLOSE_ERROR', { error: err.message });
    });
  }

  if (process.stdin.setRawMode) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
  logStateTransition('CLEANUP_COMPLETED');
}

// Handle process termination
process.on('SIGINT', () => {
  logStateTransition('SIGINT_RECEIVED');
  if (claude) claude.kill();
});

process.on('SIGTERM', () => {
  logStateTransition('SIGTERM_RECEIVED');
  if (claude) claude.kill();
});

// Start the application
startClaudeNotify();