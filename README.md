# Oref Alert Poller

Polls the [Oref](https://www.oref.org.il) alert API and sends notifications for watched cities via **Telegram**, **WhatsApp** (aba_bot), and **Home Assistant**. Includes a backup history poller to catch missed alerts for cities with `useHistoryFallback` enabled.

## Configuration

All personal data is stored in `config.json` (gitignored). Copy the sample to get started:

```bash
cp config.sample.json config.json
```

Edit `config.json` with your values:

### Global Settings

| Field | Description |
|-------|-------------|
| `telegramToken` | Telegram bot token |
| `abaBotUrl` | WhatsApp aba_bot API URL |
| `haWebhookUrl` | Home Assistant webhook base URL (without token) |
| `pollIntervalMs` | Main poll interval in ms (default: 1000) |
| `historyPollIntervalMs` | History poll interval in ms (default: 10000) |

### Watchers

The `watchers` array defines groups of cities and where to send their alerts. Each watcher has:

| Field | Description |
|-------|-------------|
| `watchCities` | List of exact city/area names to watch |
| `action.telegramChatIds` | Telegram chat IDs to notify (optional) |
| `action.abaBotChatIds` | WhatsApp chat IDs to notify via aba_bot (optional) |
| `action.haWebhookTokens` | Home Assistant webhook tokens — appended to `haWebhookUrl` (optional) |
| `useHistoryFallback` | If `true`, enables the backup history poller for these cities |

Example with two watchers:

```json
{
    "telegramToken": "YOUR_BOT_TOKEN",
    "abaBotUrl": "http://localhost:8888/send-message",
    "haWebhookUrl": "http://homeassistant.local:8123/api/webhook",
    "pollIntervalMs": 1000,
    "historyPollIntervalMs": 10000,
    "watchers": [
        {
            "watchCities": ["ירוחם"],
            "action": {
                "telegramChatIds": ["YOUR_CHAT_ID"],
                "abaBotChatIds": ["YOUR_WHATSAPP_CHAT_ID"],
                "haWebhookTokens": ["YOUR_WEBHOOK_TOKEN"]
            },
            "useHistoryFallback": true
        },
        {
            "watchCities": ["תל אביב - דרום העיר ויפו", "תל אביב - מזרח"],
            "action": {
                "telegramChatIds": ["YOUR_CHAT_ID"],
                "abaBotChatIds": ["YOUR_WHATSAPP_CHAT_ID"]
            },
            "useHistoryFallback": false
        }
    ]
}
```

A city can appear in multiple watchers — each watcher sends to its own set of notification targets independently.

## Prerequisites

- **Node.js** (v18+)
- **npm**

## Setup

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build
```

## Running

### Development (no build needed)

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

### Windows Service

Requires an **elevated (Administrator) terminal**.

```bash
# Build first
npm run build

# Install & start the service
npm run service:install

# Uninstall the service
npm run service:uninstall
```

Once installed, the service runs automatically on boot. You can manage it from `services.msc` — it appears as **"Oref Alert Poller"**.

## Logs

| File | Description |
|------|-------------|
| `logs/alerts.log` | Raw JSON of alerts matching watched cities |
| `logs/my_alerts.log` | Formatted filtered alerts (including late alerts from history) |

## How It Works

### Main Poller (every 1 second)
- Fetches `https://www.oref.org.il/warningMessages/alert/Alerts.json`
- For each watcher, filters for matching cities (exact match against `watchCities`)
- Deduplicates by alert ID
- Sends notifications to all targets defined in the watcher's `action`

### History Backup Poller (every 10 seconds)
- Runs for all cities in watchers with `useHistoryFallback: true`
- Fetches the Oref alert history API per city
- Only checks the most recent (first) entry
- If the alert is less than 10 minutes old and wasn't already sent by the main poller, sends it as a **late alert** with the original alert time and current time
- Ensures no alerts are missed even if the main poller didn't catch them

## Cooldown

Duplicate alerts for the same **city + title** are suppressed for **9 minutes**. Both pollers share the same cooldown map, so the history poller won't re-send alerts already sent by the main poller.

## Notifications

- **Telegram** — sent to all `telegramChatIds` in the matching watcher (Markdown formatting)
- **WhatsApp ([aba_bot](https://github.com/erezdaniel7/aba_bot/?tab=readme-ov-file#http-api))** — sent to all `abaBotChatIds` in the matching watcher via aba_bot API
- **Home Assistant** — webhook triggered for all `haWebhookTokens` in the matching watcher (token appended to `haWebhookUrl`)
- **Late alerts** (from history poller) include:
  - ⏰ Original alert time
  - 🕐 Current time
  - ⚠️ "התרעה באיחור!" label
