#!/usr/bin/env node

const pty = require('node-pty');
const axios = require('axios');
const { program } = require('commander');
const fs = require('fs');
const path = require('path');

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
  .allowUnknownOption(true)
  .parse();

const options = program.opts();

// Configuration
const NOTIFICATION_TIMEOUT = parseInt(options.timeout);
const SLACK_WEBHOOK_URL = options.webhookUrl || process.env.SLACK_WEBHOOK_URL;
const NOTIFICATIONS_DISABLED = options.disableNotifications;
const DEBUG_MODE = options.debug;

// Audit logging setup
const AUDIT_LOG_FILE = path.join(process.cwd(), 'claude-notify-audit.log');
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
      }
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

// State variables
let userHasEngaged = false;
let notificationSent = false;
let isClaudeWorking = false;
let notificationTimer = null;
let currentState = 'IDLE'; // IDLE, WORKING, WAITING, NOTIFIED

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

// Validate configuration
if (!NOTIFICATIONS_DISABLED && !SLACK_WEBHOOK_URL) {
  console.error('Error: SLACK_WEBHOOK_URL environment variable or --webhook-url option is required.');
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

// Spawn claude subprocess with PTY
const claude = pty.spawn('claude', claudeArgs, {
  name: 'xterm-256color',
  cols: process.stdout.columns || 80,
  rows: process.stdout.rows || 24,
  cwd: process.cwd(),
  env: { ...process.env, FORCE_COLOR: '1', TERM: 'xterm-256color' }
});

// Handle spawn errors
claude.on('error', (error) => {
  logStateTransition('CLAUDE_SPAWN_ERROR', { error: error.message });
  process.exit(1);
});

// Monitor Claude's output
claude.onData((data) => {
  process.stdout.write(data);
  
  const containsInterruptText = data.includes('to interrupt)');
  
  logStateTransition('CLAUDE_OUTPUT_RECEIVED', {
    dataLength: data.length,
    containsInterruptText,
    currentState,
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
  cleanup();
  process.exit(exitCode);
});

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
    
    const messageText = `Claude is waiting for your input`;
    
    const payload = {
      text: messageText,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🤖 *${messageText}*`
          }
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Session ID: ${sessionId} | Directory: \`${cwd}\``
            }
          ]
        }
      ]
    };
    
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
function cleanup() {
  logStateTransition('CLEANUP_STARTED');
  clearAllTimers('cleanup');
  if (process.stdin.setRawMode) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
  logStateTransition('CLEANUP_COMPLETED');
}

// Handle process termination
process.on('SIGINT', () => {
  logStateTransition('SIGINT_RECEIVED');
  cleanup();
  claude.kill();
});

process.on('SIGTERM', () => {
  logStateTransition('SIGTERM_RECEIVED');
  cleanup();
  claude.kill();
});

// Resume stdin
process.stdin.resume();