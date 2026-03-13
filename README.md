# Oref Alert Poller

Polls the [Oref](https://www.oref.org.il) alert API and sends notifications for watched cities via **Telegram**, **WhatsApp** (aba_bot), and **Home Assistant**. Includes a backup history poller for your home city to catch missed alerts.

## Configuration

All personal data is stored in `config.json` (gitignored). Copy the sample to get started:

```bash
cp config.sample.json config.json
```

Edit `config.json` with your values:

| Field | Description |
|-------|-------------|
| `telegramToken` | Telegram bot token |
| `telegramChatId` | Telegram chat ID to send alerts to |
| `abaBotUrl` | WhatsApp aba_bot API URL |
| `abaBotChatId` | WhatsApp chat ID |
| `abaBotFamilyChatId` | WhatsApp family group chat ID (home city alerts) |
| `haWebhookUrl` | Home Assistant webhook URL |
| `watchedCities` | List of exact city/area names to watch |
| `homeCity` | Home city — gets priority notifications + family group + HA + history poller |
| `pollIntervalMs` | Main poll interval in ms (default: 1000) |
| `historyPollIntervalMs` | History poll interval in ms (default: 10000) |

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
- Filters for watched cities (exact match against `watchedCities` list)
- Deduplicates by alert ID
- **Home city is sent first** as a separate message to Telegram, WhatsApp, family group, and Home Assistant
- **All other matched cities are merged** into a single message with a list of areas

### History Backup Poller (every 10 seconds)
- Fetches the Oref alert history API for the configured `homeCity`
- Only checks the most recent (first) entry
- If the alert is less than 10 minutes old and wasn't already sent by the main poller, sends it as a **late alert** with the original alert time and current time
- Ensures no alerts are missed even if the main poller didn't catch them

## Cooldown

Duplicate alerts for the same **city + title** are suppressed for **9 minutes**. Both pollers share the same cooldown map, so the history poller won't re-send alerts already sent by the main poller.

## Notifications

- **Telegram** — sent to configured chat ID (Markdown formatting)
- **WhatsApp (aba_bot)** — sent via aba_bot API
  - Home city alerts are also forwarded to the family group
- **Home Assistant** — webhook triggered for home city alerts
- **Late alerts** (from history poller) include:
  - ⏰ Original alert time
  - 🕐 Current time
  - ⚠️ "התרעה באיחור!" label
