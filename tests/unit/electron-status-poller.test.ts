/**
 * Tests for electron/lib/statusPoller.js
 *
 * Covers:
 * - routeClass() classifies free/paid/unknown providers correctly
 * - FREE_PROVIDERS and PAID_PROVIDERS set contents
 * - deriveSessionStats equivalents via StatusPoller.get() initial state
 * - StatusPoller constructor produces safe default state
 * - StatusPoller.stop() is idempotent
 * - StatusPoller reads call logs from DATA_DIR and derives correct session stats
 * - Only /chat/completions paths with 2xx status count as real requests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  StatusPoller,
  routeClass,
  FREE_PROVIDERS,
  PAID_PROVIDERS,
} = require("../../electron/lib/statusPoller");

// ─── helpers ─────────────────────────────────────────────────────────────────

function writeCallLog(logDir: string, name: string, summary: Record<string, unknown>) {
  writeFileSync(join(logDir, name), JSON.stringify({ summary }));
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── routeClass ──────────────────────────────────────────────────────────────

describe("routeClass", () => {
  it("returns FREE for opencode", () => {
    assert.equal(routeClass("opencode"), "FREE");
  });

  it("returns FREE for opencode-zen", () => {
    assert.equal(routeClass("opencode-zen"), "FREE");
  });

  it("returns FREE for opencode-go", () => {
    assert.equal(routeClass("opencode-go"), "FREE");
  });

  it("returns FREE for opencode-cli", () => {
    assert.equal(routeClass("opencode-cli"), "FREE");
  });

  it("returns PAID for anthropic", () => {
    assert.equal(routeClass("anthropic"), "PAID");
  });

  it("returns PAID for openai", () => {
    assert.equal(routeClass("openai"), "PAID");
  });

  it("returns PAID for gemini", () => {
    assert.equal(routeClass("gemini"), "PAID");
  });

  it("returns PAID for groq", () => {
    assert.equal(routeClass("groq"), "PAID");
  });

  it("returns PAID for cohere", () => {
    assert.equal(routeClass("cohere"), "PAID");
  });

  it("returns PAID for mistral", () => {
    assert.equal(routeClass("mistral"), "PAID");
  });

  it("is case-insensitive", () => {
    assert.equal(routeClass("Anthropic"), "PAID");
    assert.equal(routeClass("OPENCODE"), "FREE");
  });

  it("returns UNKNOWN for unrecognised provider", () => {
    assert.equal(routeClass("some-unknown-provider"), "UNKNOWN");
  });

  it("returns UNKNOWN for null/undefined", () => {
    assert.equal(routeClass(null), "UNKNOWN");
    assert.equal(routeClass(undefined), "UNKNOWN");
    assert.equal(routeClass(""), "UNKNOWN");
  });
});

// ─── provider sets ───────────────────────────────────────────────────────────

describe("FREE_PROVIDERS and PAID_PROVIDERS", () => {
  it("FREE_PROVIDERS is a Set containing the four free variants", () => {
    assert.ok(FREE_PROVIDERS instanceof Set);
    assert.ok(FREE_PROVIDERS.has("opencode"));
    assert.ok(FREE_PROVIDERS.has("opencode-zen"));
    assert.ok(FREE_PROVIDERS.has("opencode-go"));
    assert.ok(FREE_PROVIDERS.has("opencode-cli"));
  });

  it("PAID_PROVIDERS is a Set containing the major billing providers", () => {
    assert.ok(PAID_PROVIDERS instanceof Set);
    for (const p of ["anthropic", "openai", "gemini", "groq", "cohere", "mistral"]) {
      assert.ok(PAID_PROVIDERS.has(p), `Expected ${p} in PAID_PROVIDERS`);
    }
  });

  it("FREE and PAID sets are disjoint", () => {
    for (const p of FREE_PROVIDERS) {
      assert.ok(!PAID_PROVIDERS.has(p), `${p} should not be in PAID_PROVIDERS`);
    }
  });
});

// ─── StatusPoller initial state ───────────────────────────────────────────────

describe("StatusPoller constructor", () => {
  it("get() returns safe defaults before first poll", () => {
    const poller = new StatusPoller(() => {});
    const state = poller.get();
    assert.equal(state.health, "unknown");
    assert.equal(state.provider, null);
    assert.equal(state.model, null);
    assert.equal(state.routeClass, "UNKNOWN");
    assert.equal(state.lastRequestAt, null);
    assert.equal(state.lastLatencyMs, null);
    assert.equal(state.sessionTotal, 0);
    assert.equal(state.sessionFree, 0);
    assert.equal(state.sessionPaid, 0);
    assert.equal(state.sessionCost, 0);
    assert.equal(state.warning, null);
  });

  it("get() returns a defensive copy — mutations do not affect internal state", () => {
    const poller = new StatusPoller(() => {});
    const a = poller.get();
    a.health = "healthy";
    a.sessionTotal = 999;
    const b = poller.get();
    assert.equal(b.health, "unknown");
    assert.equal(b.sessionTotal, 0);
  });

  it("stop() is safe to call before start()", () => {
    const poller = new StatusPoller(() => {});
    assert.doesNotThrow(() => poller.stop());
  });

  it("stop() is idempotent", () => {
    const poller = new StatusPoller(() => {});
    poller.stop();
    assert.doesNotThrow(() => poller.stop());
  });
});

// ─── call-log reading ─────────────────────────────────────────────────────────

describe("StatusPoller call-log reading (DATA_DIR override)", () => {
  it("reads today's call logs and accumulates free/paid counts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omniroute-poller-"));
    const originalDataDir = process.env.DATA_DIR;
    try {
      const logDir = join(dir, "call_logs", todayDate());
      mkdirSync(logDir, { recursive: true });

      // Two free requests
      writeCallLog(logDir, "001.json", {
        path: "/v1/chat/completions",
        status: 200,
        provider: "opencode",
        model: "big-pickle",
        timestamp: "2026-09-11T10:00:00.000Z",
        duration: 1500,
        cost: 0,
      });
      writeCallLog(logDir, "002.json", {
        path: "/v1/chat/completions",
        status: 200,
        provider: "opencode",
        model: "big-pickle",
        timestamp: "2026-09-11T10:01:00.000Z",
        duration: 2000,
        cost: 0,
      });
      // One paid request
      writeCallLog(logDir, "003.json", {
        path: "/v1/chat/completions",
        status: 200,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        timestamp: "2026-09-11T10:02:00.000Z",
        duration: 3000,
        cost: 0.05,
      });

      process.env.DATA_DIR = dir;
      const poller = new StatusPoller(() => {});
      // poll() awaits one full cycle (health + log read) without starting the interval.
      await poller.poll();
      poller.stop();

      const s = poller.get();
      assert.equal(s.sessionTotal, 3, `Expected total=3, got ${s.sessionTotal}`);
      assert.equal(s.sessionFree, 2, `Expected free=2, got ${s.sessionFree}`);
      assert.equal(s.sessionPaid, 1, `Expected paid=1, got ${s.sessionPaid}`);
      // 003.json sorts last alphabetically → most recent when reversed
      assert.equal(s.provider, "anthropic");
      assert.equal(s.model, "claude-3-5-sonnet-20241022");
    } finally {
      if (originalDataDir !== undefined) {
        process.env.DATA_DIR = originalDataDir;
      } else {
        delete process.env.DATA_DIR;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores non-chat-completions paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omniroute-poller-"));
    const originalDataDir = process.env.DATA_DIR;
    try {
      const logDir = join(dir, "call_logs", todayDate());
      mkdirSync(logDir, { recursive: true });
      writeCallLog(logDir, "001.json", {
        path: "/api/health",
        status: 200,
        provider: "opencode",
        model: "big-pickle",
      });
      writeCallLog(logDir, "002.json", {
        path: "/v1/models",
        status: 200,
        provider: "opencode",
        model: "big-pickle",
      });

      process.env.DATA_DIR = dir;
      const poller = new StatusPoller(() => {});
      await poller.poll();
      poller.stop();
      assert.equal(poller.get().sessionTotal, 0, "health/models calls should not count");
    } finally {
      if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
      else delete process.env.DATA_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores error responses (non-2xx)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omniroute-poller-"));
    const originalDataDir = process.env.DATA_DIR;
    try {
      const logDir = join(dir, "call_logs", todayDate());
      mkdirSync(logDir, { recursive: true });
      writeCallLog(logDir, "001.json", {
        path: "/v1/chat/completions",
        status: 401,
        provider: "anthropic",
        model: "claude-3-5-sonnet",
      });
      writeCallLog(logDir, "002.json", {
        path: "/v1/chat/completions",
        status: 500,
        provider: "opencode",
        model: "big-pickle",
      });

      process.env.DATA_DIR = dir;
      const poller = new StatusPoller(() => {});
      await poller.poll();
      poller.stop();
      assert.equal(poller.get().sessionTotal, 0, "4xx/5xx responses should not count");
    } finally {
      if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
      else delete process.env.DATA_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty stats when call_logs directory does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omniroute-poller-"));
    const originalDataDir = process.env.DATA_DIR;
    try {
      // No call_logs subdirectory — poller should handle gracefully
      process.env.DATA_DIR = dir;
      const poller = new StatusPoller(() => {});
      await poller.poll();
      poller.stop();
      const s = poller.get();
      assert.equal(s.sessionTotal, 0);
      assert.equal(s.provider, null);
    } finally {
      if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
      else delete process.env.DATA_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accumulates cost from call logs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omniroute-poller-"));
    const originalDataDir = process.env.DATA_DIR;
    try {
      const logDir = join(dir, "call_logs", todayDate());
      mkdirSync(logDir, { recursive: true });
      writeCallLog(logDir, "001.json", {
        path: "/v1/chat/completions",
        status: 200,
        provider: "anthropic",
        model: "claude-opus",
        cost: 0.1,
      });
      writeCallLog(logDir, "002.json", {
        path: "/v1/chat/completions",
        status: 200,
        provider: "anthropic",
        model: "claude-opus",
        cost: 0.05,
      });

      process.env.DATA_DIR = dir;
      const poller = new StatusPoller(() => {});
      await poller.poll();
      poller.stop();
      const s = poller.get();
      assert.ok(
        Math.abs(s.sessionCost - 0.15) < 0.001,
        `Expected sessionCost≈0.15, got ${s.sessionCost}`
      );
    } finally {
      if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
      else delete process.env.DATA_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("onChange callback is fired when state changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omniroute-poller-"));
    const originalDataDir = process.env.DATA_DIR;
    try {
      const logDir = join(dir, "call_logs", todayDate());
      mkdirSync(logDir, { recursive: true });
      writeCallLog(logDir, "001.json", {
        path: "/v1/chat/completions",
        status: 200,
        provider: "opencode",
        model: "big-pickle",
      });

      const changes: unknown[] = [];
      process.env.DATA_DIR = dir;
      const poller = new StatusPoller((s: unknown) => changes.push(s));
      await poller.poll();
      poller.stop();
      assert.ok(changes.length >= 1, "onChange should have been called at least once");
    } finally {
      if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
      else delete process.env.DATA_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
