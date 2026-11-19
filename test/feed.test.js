import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCES, pendingRows } from "../mods/herdr-token-viewer/usage.js";
import { createFeed } from "../mods/herdr-token-viewer/feed.js";

const MIN = 60000;
const NOW = Date.parse("2026-11-12T01:30:00Z");

function makeHarness() {
  let time = NOW;
  /** @type {{ id: number, at: number, everyMs: number | null, fn: () => void, cancelled: boolean }[]} */
  const timers = [];
  let nextTimerId = 1;
  /** @type {{ command: string, args: string[], timeout: number, resolve: (v: unknown) => void, reject: (e: unknown) => void }[]} */
  const calls = [];

  const scheduler = {
    every(ms, fn) {
      const entry = { id: nextTimerId++, at: time + ms, everyMs: ms, fn, cancelled: false };
      timers.push(entry);
      return { cancel() { entry.cancelled = true; } };
    },
    after(ms, fn) {
      const entry = { id: nextTimerId++, at: time + ms, everyMs: null, fn, cancelled: false };
      timers.push(entry);
      return { cancel() { entry.cancelled = true; } };
    },
    spawn(fn) {
      void Promise.resolve().then(fn);
      return { cancel() {} };
    },
  };

  /** @param {string} command @param {string[]} args @param {{ timeout?: number }} [opts] */
  function exec(command, args, opts = {}) {
    return new Promise((resolve, reject) => {
      calls.push({ command, args, timeout: opts.timeout ?? 0, resolve, reject });
    });
  }

  /** @param {number} ms */
  async function advance(ms) {
    const target = time + ms;
    for (;;) {
      const due = timers
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      time = due.at;
      if (due.everyMs !== null) {
        due.at += due.everyMs;
      } else {
        due.cancelled = true;
      }
      due.fn();
      await flush();
    }
    time = target;
  }

  async function flush() {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  }

  return {
    now: () => time,
    setNow: (t) => { time = t; },
    timers,
    calls,
    scheduler,
    exec,
    advance,
    flush,
  };
}

const sampleQuota = {
  schemaVersion: 5,
  generatedAt: "2026-11-12T01:30:00.000Z",
  providers: [
    { provider: "claude", plan: "max", state: { status: "fresh" }, windows: [{ id: "five_hour", percentRemaining: 80 }] },
    { provider: "agy", state: { status: "fresh" }, windows: [{ id: "gemini_5h", percentRemaining: 90 }] },
  ],
};

const sampleCodex = {
  accounts: [
    {
      index: 0, enabled: true, current: true, label: "Account 1",
      quota: { updatedAt: NOW, primary: { usedPercent: 10, windowMinutes: 300, resetAtMs: NOW + 60 * MIN } },
    },
  ],
};

test("two copies initialized together share one quota-axi call and one codex-multi-auth call", async () => {
  const h = makeHarness();
  const feed = createFeed({ exec: h.exec, sources: SOURCES, initialRows: pendingRows, now: h.now });

  const copy1 = feed.attach(h.scheduler);
  const copy2 = feed.attach(h.scheduler);
  await h.flush();

  assert.deepEqual(h.calls.map((c) => c.command), ["quota-axi", "codex-multi-auth"]);

  const w1 = copy1.waitUpdate();
  const w2 = copy2.waitUpdate();
  h.calls[0].resolve({ code: 0, stdout: JSON.stringify(sampleQuota) });
  h.calls[1].resolve({ code: 0, stdout: JSON.stringify(sampleCodex) });
  await h.flush();

  assert.equal(await w1, true);
  assert.equal(await w2, true);
  assert.equal(feed.rows.quota[0].fiveHour?.left, 80);
  assert.equal(feed.rows.codex[0].fiveHour?.left, 90);

  // One shared timer per source plus the minute redraw timer (3 total, not 6).
  assert.equal(h.timers.filter((t) => !t.cancelled).length, 3);

  copy1.detach();
  copy2.detach();
});

test("a hidden copy and a visible copy share one periodic cadence without extra calls", async () => {
  const h = makeHarness();
  const feed = createFeed({ exec: h.exec, sources: SOURCES, initialRows: pendingRows, now: h.now });

  const hidden = feed.attach(h.scheduler);
  await h.flush();
  assert.equal(h.calls.length, 2);
  h.calls[0].resolve({ code: 0, stdout: JSON.stringify(sampleQuota) });
  h.calls[1].resolve({ code: 0, stdout: JSON.stringify(sampleCodex) });
  await h.flush();

  // Second copy opens 30s later: reuses existing rows, triggers no extra CLI call.
  await h.advance(30_000);
  const visible = feed.attach(h.scheduler);
  await h.flush();
  assert.equal(h.calls.length, 2);
  assert.equal(feed.rows.quota[0].fiveHour?.left, 80);

  // At 120s total, quota runs once more (not twice); codex has not fired yet.
  await h.advance(90_000);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].command, "quota-axi");
  h.calls[2].resolve({ code: 0, stdout: JSON.stringify(sampleQuota) });
  await h.flush();

  // Detach the first copy; the second keeps the shared timers running up to 360s.
  hidden.detach();
  assert.equal(h.timers.filter((t) => !t.cancelled).length, 3);
  await h.advance(120_000);
  assert.equal(h.calls[3].command, "quota-axi");
  h.calls[3].resolve({ code: 0, stdout: JSON.stringify(sampleQuota) });
  await h.flush();
  await h.advance(120_000);
  assert.deepEqual(h.calls.slice(3).map((c) => c.command), ["quota-axi", "quota-axi", "codex-multi-auth"]);

  visible.detach();
  assert.equal(h.timers.filter((t) => !t.cancelled).length, 0);
});

test("closing all copies and reopening within the interval waits the remaining time instead of re-running", async () => {
  const h = makeHarness();
  const feed = createFeed({ exec: h.exec, sources: SOURCES, initialRows: pendingRows, now: h.now });

  const copy1 = feed.attach(h.scheduler);
  await h.flush();
  h.calls[0].resolve({ code: 0, stdout: JSON.stringify(sampleQuota) });
  h.calls[1].resolve({ code: 0, stdout: JSON.stringify(sampleCodex) });
  await h.flush();
  copy1.detach();
  assert.equal(h.timers.filter((t) => !t.cancelled).length, 0);

  // Reopen 40s later: no immediate exec; quota fires after the remaining 80s.
  await h.advance(40_000);
  const copy2 = feed.attach(h.scheduler);
  await h.flush();
  assert.equal(h.calls.length, 2);

  await h.advance(79_999);
  assert.equal(h.calls.length, 2);
  await h.advance(1);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].command, "quota-axi");

  copy2.detach();
});

test("exec rejection becomes unavailable rows and releases the in-flight lock for the next round", async () => {
  const h = makeHarness();
  const feed = createFeed({ exec: h.exec, sources: SOURCES, initialRows: pendingRows, now: h.now });

  const copy = feed.attach(h.scheduler);
  await h.flush();
  h.calls[0].reject(new Error("enoent"));
  h.calls[1].resolve({ code: 0, stdout: JSON.stringify(sampleCodex) });
  await h.flush();

  assert.equal(feed.rows.quota[0].reason, "quota-axi could not be run");

  await h.advance(SOURCES.quota.intervalMs);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].command, "quota-axi");

  copy.detach();
});
