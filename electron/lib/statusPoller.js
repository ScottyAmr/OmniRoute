/**
 * OmniRoute Status Poller
 *
 * Polls the OmniRoute server health endpoint and reads recent call logs
 * from the SQLite database to produce a compact status summary for the
 * system tray. Runs entirely in the Electron main process.
 *
 * Status shape:
 *   { health, provider, model, routeClass, lastRequestAt, lastLatencyMs,
 *     sessionTotal, sessionFree, sessionPaid, sessionCost, warning }
 */

"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// ─── Constants ───────────────────────────────────────────────────────────────

const HEALTH_URL = "http://127.0.0.1:20128/api/health";
const POLL_INTERVAL_MS = 8000; // 8 s between polls

// Providers that are always free / keyless — no billing risk.
const FREE_PROVIDERS = new Set(["opencode", "opencode-zen", "opencode-go", "opencode-cli"]);
// Providers that bill per token.
const PAID_PROVIDERS = new Set(["anthropic", "openai", "gemini", "groq", "cohere", "mistral"]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveDataDir() {
  const configured = process.env.DATA_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), ".omniroute");
}

function routeClass(provider) {
  if (!provider) return "UNKNOWN";
  const p = String(provider).toLowerCase();
  if (FREE_PROVIDERS.has(p)) return "FREE";
  if (PAID_PROVIDERS.has(p)) return "PAID";
  return "UNKNOWN";
}

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
  });
}

/**
 * Read the most recent N call-log JSON files from the given date directory.
 * Returns parsed objects, skipping unreadable files.
 */
function readRecentCallLogs(dataDir, count = 20) {
  const today = new Date().toISOString().slice(0, 10);
  const logDir = path.join(dataDir, "call_logs", today);
  let files;
  try {
    files = fs.readdirSync(logDir).sort().reverse().slice(0, count);
  } catch {
    return [];
  }
  const logs = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(logDir, file), "utf8");
      logs.push(JSON.parse(raw));
    } catch {
      // skip malformed
    }
  }
  return logs;
}

/**
 * Derive session stats from today's call logs.
 * Only counts /v1/chat/completions paths (actual AI requests, not tests).
 */
function deriveSessionStats(logs) {
  let total = 0;
  let free = 0;
  let paid = 0;
  let cost = 0;
  let lastProvider = null;
  let lastModel = null;
  let lastRequestAt = null;
  let lastLatencyMs = null;

  for (const log of logs) {
    const s = log?.summary;
    if (!s) continue;
    if (!String(s.path || "").includes("/chat/completions")) continue;
    if (s.status < 200 || s.status >= 300) continue;

    total++;
    const cls = routeClass(s.provider);
    if (cls === "FREE") free++;
    else if (cls === "PAID") paid++;

    // Cost is stored in cents in some schemas; keep it agnostic.
    const logCost = parseFloat(s.cost ?? s.estimated_cost ?? 0) || 0;
    cost += logCost;

    // The first log is the most recent (sorted descending).
    if (!lastProvider) {
      lastProvider = s.provider || null;
      lastModel = s.model || null;
      lastRequestAt = s.timestamp || null;
      lastLatencyMs = s.duration || null;
    }
  }

  return { total, free, paid, cost, lastProvider, lastModel, lastRequestAt, lastLatencyMs };
}

// ─── StatusPoller class ───────────────────────────────────────────────────────

class StatusPoller {
  constructor(onChange) {
    this._onChange = onChange;
    this._timer = null;
    this._dataDir = resolveDataDir();
    this._status = {
      health: "unknown", // "healthy" | "unhealthy" | "unknown"
      provider: null,
      model: null,
      routeClass: "UNKNOWN",
      lastRequestAt: null,
      lastLatencyMs: null,
      sessionTotal: 0,
      sessionFree: 0,
      sessionPaid: 0,
      sessionCost: 0,
      warning: null,
    };
  }

  start() {
    this._poll();
    this._timer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  poll() {
    return this._poll();
  }

  get() {
    return { ...this._status };
  }

  async _poll() {
    let health = "unknown";
    let warning = null;

    // 1. Check server health.
    try {
      const res = await httpGet(HEALTH_URL);
      health = res?.status === "ok" ? "healthy" : "unhealthy";
    } catch {
      health = "unhealthy";
      warning = "Server unreachable";
    }

    // 2. Read recent call logs for routing info.
    const logs = readRecentCallLogs(this._dataDir);
    const stats = deriveSessionStats(logs);

    const next = {
      health,
      provider: stats.lastProvider,
      model: stats.lastModel,
      routeClass: stats.lastProvider ? routeClass(stats.lastProvider) : "UNKNOWN",
      lastRequestAt: stats.lastRequestAt,
      lastLatencyMs: stats.lastLatencyMs,
      sessionTotal: stats.total,
      sessionFree: stats.free,
      sessionPaid: stats.paid,
      sessionCost: stats.cost,
      warning,
    };

    const changed = JSON.stringify(next) !== JSON.stringify(this._status);
    this._status = next;
    if (changed && this._onChange) {
      this._onChange(next);
    }
  }
}

module.exports = { StatusPoller, routeClass, FREE_PROVIDERS, PAID_PROVIDERS };
