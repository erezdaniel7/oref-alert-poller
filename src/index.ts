import fs from "fs";
import path from "path";
import http from "http";
import https from "https";

// ── Load config ─────────────────────────────────────────────────────────────
interface AppConfig {
    telegramToken: string;
    telegramChatId: string;
    abaBotUrl: string;
    abaBotChatId: string;
    abaBotFamilyChatId: string;
    haWebhookUrl: string;
    watchedCities: string[];
    homeCity: string;
    pollIntervalMs: number;
    historyPollIntervalMs: number;
}

const CONFIG_PATH = path.join(__dirname, "..", "config.json");
if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config file not found: ${CONFIG_PATH}`);
    console.error("Copy config.sample.json to config.json and fill in your values.");
    process.exit(1);
}
const config: AppConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

// ── Config ──────────────────────────────────────────────────────────────────
const ALERT_URL = "https://www.oref.org.il/warningMessages/alert/Alerts.json";
const LOG_DIR = path.join(__dirname, "..", "logs");
const RAW_LOG = path.join(LOG_DIR, "alerts.log");
const FILTERED_LOG = path.join(LOG_DIR, "my_alerts.log");
const POLL_INTERVAL_MS = config.pollIntervalMs;
const HISTORY_POLL_INTERVAL_MS = config.historyPollIntervalMs;
const HISTORY_MAX_AGE_MS = 10 * 60 * 1000; // only care about alerts from last 10 min

// History URL – city is URL-encoded from config
const HOME_CITY = config.homeCity;
const HOME_HISTORY_URL =
    `https://alerts-history.oref.org.il//Shared/Ajax/GetAlarmsHistory.aspx?lang=he&mode=1&city_0=${encodeURIComponent(HOME_CITY)}`;

// Telegram bot config
const TELEGRAM_TOKEN = config.telegramToken;
const TELEGRAM_CHAT_ID = config.telegramChatId;

// Aba bot config
const ABA_BOT_URL = config.abaBotUrl;
const ABA_BOT_CHAT_ID = config.abaBotChatId;
const ABA_BOT_FAMILY_CHAT_ID = config.abaBotFamilyChatId;

// Home Assistant webhook config
const HA_WEBHOOK_URL = config.haWebhookUrl;

// Cities to watch – exact area names from oref
const WATCHED_CITIES: string[] = config.watchedCities;

// ── Category → emoji map ────────────────────────────────────────────────────
const CATEGORY_EMOJI: Record<number, string> = {
    1: "🚀",   // missilealert
    2: "✈️",   // uav
    3: "☢️",   // nonconventional
    4: "🚨",   // warning
    5: "🎆",   // memorialday1
    6: "🎆",   // memorialday2
    7: "🌍",   // earthquakealert1
    8: "🌍",   // earthquakealert2
    9: "☢️",   // cbrne
    10: "⚔️",  // terrorattack
    11: "🌊",  // tsunami
    12: "☣️",  // hazmat
    13: "⚠",   // update
    14: "⚡",  // flash
    15: "✅",  // missilealertdrill
    16: "✅",  // uavdrill
    17: "✅",  // nonconventionaldrill
    18: "✅",  // warningdrill
    19: "✅",  // memorialdaydrill1
    20: "✅",  // memorialdaydrill2
    21: "✅",  // earthquakedrill1
    22: "✅",  // earthquakedrill2
    23: "✅",  // cbrnedrill
    24: "✅",  // terrorattackdrill
    25: "✅",  // tsunamidrill
    26: "✅",  // hazmatdrill
    27: "✅",  // updatedrill
    28: "✅",  // flashdrill
};

// ── Alert JSON shape ────────────────────────────────────────────────────────
interface OrefAlert {
    id: string;
    cat: string;
    title: string;
    data: string[];
    desc: string;
}

// Track alert IDs we've already processed so we don't log duplicates
const processedAlertIds = new Set<string>();

// Track history rids we've already processed (for the backup history poller)
const processedHistoryRids = new Set<number>();

// Cooldown: per city+cat+title+desc → last time it was logged
const COOLDOWN_MS = 9 * 60 * 1000; // 9 minutes
const lastNotified = new Map<string, number>();

// ── Helpers ─────────────────────────────────────────────────────────────────
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getTimestamp(): string {
    return new Date().toISOString();
}

function appendToRawLog(message: string): void {
    const line = `[${getTimestamp()}] ${message}\n`;
    fs.appendFileSync(RAW_LOG, line, "utf-8");
}

function appendToFilteredLog(message: string): void {
    const line = `[${getTimestamp()}] ${message}\n`;
    fs.appendFileSync(FILTERED_LOG, line, "utf-8");
}

function cityMatches(city: string): boolean {
    return WATCHED_CITIES.includes(city);
}

function getEmoji(cat: string): string {
    const num = parseInt(cat, 10);
    return CATEGORY_EMOJI[num] ?? "❓";
}

function getIsraelUtcOffset(): string {
    // Get current offset for Asia/Jerusalem by formatting a date
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en", { timeZone: "Asia/Jerusalem", timeZoneName: "shortOffset" });
    const parts = fmt.formatToParts(now);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    // tzPart.value is like "GMT+2" or "GMT+3"
    if (tzPart) {
        const match = tzPart.value.match(/GMT([+-]\d+)/);
        if (match) {
            const hours = parseInt(match[1], 10);
            const sign = hours >= 0 ? "+" : "-";
            return `${sign}${String(Math.abs(hours)).padStart(2, "0")}:00`;
        }
    }
    return "+02:00"; // fallback to IST
}

// ── Home Assistant ──────────────────────────────────────────────────────────
interface HAPayload {
    emoji: string;
    title: string;
    desc: string;
    category: string;
    message: string;
    area: string;
}

function sendHomeAssistant(data: HAPayload): void {
    const payload = JSON.stringify(data);
    const urlObj = new URL(HA_WEBHOOK_URL);
    const req = http.request(
        {
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
            },
        },
        (res) => {
            let body = "";
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () => {
                if (res.statusCode !== 200) {
                    console.error(`[${getTimestamp()}] HA webhook error ${res.statusCode}: ${body}`);
                }
            });
        }
    );
    req.on("error", (err: Error) => {
        console.error(`[${getTimestamp()}] HA webhook request failed: ${err.message}`);
    });
    req.write(payload);
    req.end();
}

// ── Aba Bot (WhatsApp) ──────────────────────────────────────────────────────
function sendAbaBot(text: string, chatId: string = ABA_BOT_CHAT_ID): void {
    const payload = JSON.stringify({
        chatId,
        content: text,
    });

    const urlObj = new URL(ABA_BOT_URL);
    const req = http.request(
        {
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
            },
        },
        (res) => {
            let body = "";
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () => {
                if (res.statusCode !== 200) {
                    console.error(`[${getTimestamp()}] AbaBot error ${res.statusCode}: ${body}`);
                }
            });
        }
    );
    req.on("error", (err: Error) => {
        console.error(`[${getTimestamp()}] AbaBot request failed: ${err.message}`);
    });
    req.write(payload);
    req.end();
}

// ── Telegram ────────────────────────────────────────────────────────────────
function sendTelegram(text: string): void {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const payload = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
    });

    const urlObj = new URL(url);
    const req = https.request(
        {
            hostname: urlObj.hostname,
            path: urlObj.pathname,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
            },
        },
        (res) => {
            let body = "";
            res.on("data", (chunk: string) => (body += chunk));
            res.on("end", () => {
                if (res.statusCode !== 200) {
                    console.error(`[${getTimestamp()}] Telegram error ${res.statusCode}: ${body}`);
                }
            });
        }
    );
    req.on("error", (err: Error) => {
        console.error(`[${getTimestamp()}] Telegram request failed: ${err.message}`);
    });
    req.write(payload);
    req.end();
}

// ── History alert shape ─────────────────────────────────────────────────────
interface HistoryAlert {
    data: string;
    date: string;
    time: string;
    alertDate: string;
    category: number;
    category_desc: string;
    matrix_id: number;
    rid: number;
    NAME_HE: string;
}

// ── Fetch ───────────────────────────────────────────────────────────────────
function fetchAlerts(): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = https.get(
            ALERT_URL,
            {
                headers: {
                    Accept: "application/json",
                    "Accept-Language": "he",
                    Referer: "https://www.oref.org.il/",
                    "X-Requested-With": "XMLHttpRequest",
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk: string) => (data += chunk));
                res.on("end", () => resolve(data));
            }
        );
        req.on("error", (err: Error) => reject(err));
        req.setTimeout(5000, () => {
            req.destroy();
            reject(new Error("Request timed out"));
        });
    });
}

// ── Process ─────────────────────────────────────────────────────────────────
function processAlert(alert: OrefAlert): void {
    if (processedAlertIds.has(alert.id)) return;
    processedAlertIds.add(alert.id);

    const matchedCities = alert.data.filter(cityMatches);
    if (matchedCities.length === 0) return;

    // Log raw alert only if it has matching cities
    appendToRawLog(JSON.stringify(alert));

    const emoji = getEmoji(alert.cat);
    const desc = alert.desc.replace(/\n/g, " ");
    const now = Date.now();
    const localTime = new Date().toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    // 1. Home city first — most important, send immediately
    if (matchedCities.includes(HOME_CITY)) {
        const key = `${HOME_CITY}|${alert.title}`;
        const lastTime = lastNotified.get(key);
        if (!lastTime || now - lastTime >= COOLDOWN_MS) {
            lastNotified.set(key, now);
            const message = `${emoji} - *${alert.title}*\n${desc}\n📍 ${HOME_CITY}\n🕐 ${localTime}`;
            appendToFilteredLog(message.replace(/\n/g, "----"));
            sendTelegram(message);
            sendAbaBot(message);
            sendAbaBot(message, ABA_BOT_FAMILY_CHAT_ID);
            sendHomeAssistant({
                emoji,
                title: alert.title,
                desc,
                category: alert.cat,
                message,
                area: HOME_CITY,
            });
        }
    }

    // 2. Collect remaining cities not in cooldown, send as one merged message
    const otherCities = matchedCities.filter((city) => {
        if (city === HOME_CITY) return false;
        const key = `${city}|${alert.title}`;
        const lastTime = lastNotified.get(key);
        return !lastTime || now - lastTime >= COOLDOWN_MS;
    });

    if (otherCities.length > 0) {
        for (const city of otherCities) {
            lastNotified.set(`${city}|${alert.title}`, now);
        }
        const cityList = otherCities.map((c) => `📍 ${c}`).join("\n");
        const message = `${emoji} - *${alert.title}*\n${desc}\n${cityList}\n🕐 ${localTime}`;
        appendToFilteredLog(message.replace(/\n/g, "----"));
        sendTelegram(message);
        sendAbaBot(message);
    }
}

// ── History fetch & process ─────────────────────────────────────────────────
function fetchHistory(): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = https.get(
            HOME_HISTORY_URL,
            {
                headers: {
                    Accept: "application/json",
                    "Accept-Language": "he",
                    Referer: "https://www.oref.org.il/",
                    "X-Requested-With": "XMLHttpRequest",
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk: string) => (data += chunk));
                res.on("end", () => resolve(data));
            }
        );
        req.on("error", (err: Error) => reject(err));
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error("History request timed out"));
        });
    });
}

function processHistoryAlerts(alerts: HistoryAlert[]): void {
    const now = Date.now();

    // Only check the first (most recent) alert in the array
    if (alerts.length === 0) return;
    const ha = alerts[0];

    // Skip if already seen
    if (processedHistoryRids.has(ha.rid)) return;

    // Parse alert time (alertDate is in Israel local time: "2026-03-01T21:01:00")
    // Get the current Israel UTC offset dynamically to handle IST/IDT transitions
    const israelOffset = getIsraelUtcOffset();
    const alertTime = new Date(ha.alertDate + israelOffset).getTime();
    const ageMs = now - alertTime;

    // Skip alerts older than 10 minutes
    if (ageMs > HISTORY_MAX_AGE_MS || ageMs < 0) {
        processedHistoryRids.add(ha.rid);
        return;
    }

    processedHistoryRids.add(ha.rid);

    // Build cooldown key matching the main poller format (city + title text, no category)
    const emoji = getEmoji(String(ha.category));
    const cooldownKey = `${ha.data}|${ha.category_desc}`;
    const lastTime = lastNotified.get(cooldownKey);

    // If main poller already sent this within cooldown, skip
    if (lastTime && now - lastTime < COOLDOWN_MS) return;

    // This is a missed alert — send as late notification
    lastNotified.set(cooldownKey, now);

    const localTime = new Date().toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const message = `${emoji} - *${ha.category_desc}*\n📍 ${ha.data}\n⏰ שעת התרעה: ${ha.time}\n🕐 נשלח באיחור: ${localTime}\n⚠️ *התרעה באיחור!*`;

    appendToFilteredLog(message.replace(/\n/g, "----"));
    sendTelegram(message);
    sendAbaBot(message);
    // sendAbaBot(message, ABA_BOT_FAMILY_CHAT_ID);
    sendHomeAssistant({
        emoji,
        title: ha.category_desc,
        desc: ha.category_desc,
        category: String(ha.category),
        message,
        area: ha.data,
    });
}

async function pollHistory(): Promise<void> {
    try {
        const body = await fetchHistory();
        const trimmed = body.trim();
        if (trimmed.length === 0) return;

        try {
            const alerts: HistoryAlert[] = JSON.parse(trimmed);
            processHistoryAlerts(alerts);
        } catch {
            // Not valid JSON – skip
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${getTimestamp()}] Error fetching history: ${message}`);
    }
}

// ── Poll loop ───────────────────────────────────────────────────────────────
async function poll(): Promise<void> {
    try {
        const body = await fetchAlerts();
        const trimmed = body.trim();

        if (trimmed.length === 0) return;

        // Parse and process
        try {
            const alert: OrefAlert = JSON.parse(trimmed);
            processAlert(alert);
        } catch {
            // Not valid JSON – skip processing
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${getTimestamp()}] Error fetching alerts: ${message}`);
    }
}

// ── Main ────────────────────────────────────────────────────────────────────
function main(): void {
    appendToRawLog("Oref alert poller started");
    console.log(`Polling ${ALERT_URL} every ${POLL_INTERVAL_MS}ms`);
    console.log(`Raw log:      ${RAW_LOG}`);
    console.log(`Filtered log: ${FILTERED_LOG}`);

    poll();
    setInterval(poll, POLL_INTERVAL_MS);

    // History backup poller for home city (every 10s)
    console.log(`History poll: ${HOME_HISTORY_URL} every ${HISTORY_POLL_INTERVAL_MS}ms`);
    pollHistory();
    setInterval(pollHistory, HISTORY_POLL_INTERVAL_MS);
}

main();
