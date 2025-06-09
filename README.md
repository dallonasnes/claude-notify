# claude-notify

Get Slack notifications when Claude CLI is waiting for your input.

**Unofficial tool** - not affiliated with Anthropic or Claude.

## Install

```bash
npm install -g claude-notify
```

## Usage

Replace `claude` with `claude-notify` in your commands:

```bash
# Just run claude-notify (it will start claude for you)
claude-notify

# With optional flags
claude-notify --timeout 30000 --debug
```

## Setup

Set your Slack webhook URL:

```bash
export SLACK_WEBHOOK_URL="https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
```

Or pass it directly:

```bash
claude-notify --webhook-url "https://hooks.slack.com/..."
```

## Options

- `--timeout <ms>` - Notification delay (default: 15000ms)
- `--webhook-url <url>` - Slack webhook URL
- `--disable-notifications` - Run without notifications

## Requirements

- Node.js 14+
- Claude CLI installed
- Slack webhook URL (create one in your Slack workspace settings)
