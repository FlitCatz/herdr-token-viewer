import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STALE_MS, age, cell, clock, codexRows, pendingRows, quotaRows, span, tightest, tip, unavailable,
} from "../mods/herdr-token-viewer/usage.js";

const MIN = 60000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-11-12T01:30:00Z");

/** @param {unknown} report */
const ran = (report, code = 0) => ({ code, stdout: JSON.stringify(report) });

// Fictional reports shaped like `quota-axi --provider claude,agy --json`.
const quota = {
  schemaVersion: 5,
  generatedAt: "2026-11-12T01:30:00.000Z",
  providers: [
    {
      provider: "claude", plan: "max", accountKeys: ["default"], state: { status: "fresh", stale: false },
      windows: [
        { id: "five_hour", kind: "session", percentRemaining: 84, resetsAt: "2026-11-12T05:10:00.381247+00:00" },
        { id: "seven_day", kind: "weekly", percentRemaining: 38, resetsAt: "2026-11-13T19:00:00+00:00" },
        { id: "model:fable", kind: "model", percentRemaining: 77, resetsAt: "2026-11-13T19:00:00+00:00" },
      ],
    },
    {
      provider: "agy", accountKeys: ["default"], state: { status: "fresh", stale: false },
      windows: [
        { id: "gemini_argon_weekly", kind: "weekly", percentRemaining: 42, resetsAt: "2026-11-16T00:50:05.000Z" },
        { id: "gemini_5h", kind: "session", percentRemaining: 98, resetsAt: "2026-11-12T06:00:00.000Z" },
        { id: "gemini_weekly", kind: "weekly", percentRemaining: 95, resetsAt: "2026-11-16T02:30:00.000Z" },
        { id: "claude_gpt_5h", kind: "session", percentRemaining: 100, resetsAt: "2026-11-12T06:30:00.000Z" },
      ],
    },
  ],
};

// Fictional accounts shaped like `codex-multi-auth limits --json`.
/** @param {number} index @param {object} [over] */
const account = (index, over = {}) => ({
  index, enabled: true, current: false,
  label: `Account ${index + 1} (Example Team [id:ab12c${index}], ex***@***.com, id:ab12c${index})`,
  quota: {
    updatedAt: NOW - 46 * MIN, status: 200, planType: "team",
    primary: { usedPercent: 12, windowMinutes: 300, resetAtMs: NOW + 4 * HOUR + 14 * MIN },
    secondary: { usedPercent: 95, windowMinutes: 10080, resetAtMs: NOW + 26 * HOUR },
  },
  ...over,
});
const limits = { schemaVersion: 1, generatedAt: NOW, mode: "cached", accounts: [account(0), account(1), account(2, { current: true })] };

test("quotaRows reads Claude and Gemini's 5-hour and weekly windows, skipping the per-model ones", () => {
  const [claude, gemini] = quotaRows(ran(quota));
  assert.deepEqual(claude, {
    id: "claude", name: "Claude", plan: "max", readAt: NOW,
    fiveHour: { left: 84, resetAt: Date.parse("2026-11-12T05:10:00.381Z") },
    weekly: { left: 38, resetAt: Date.parse("2026-11-13T19:00:00Z") },
  });
  assert.deepEqual(gemini, {
    id: "gemini", name: "Gemini", plan: undefined, readAt: NOW,
    fiveHour: { left: 98, resetAt: Date.parse("2026-11-12T06:00:00Z") },
    weekly: { left: 95, resetAt: Date.parse("2026-11-16T02:30:00Z") },
  });
});

test("quotaRows takes a reused reading's own time, not the report's", () => {
  const report = structuredClone(quota);
  Object.assign(report.providers[0].state, { reused: true, refreshedAt: "2026-11-12T01:20:00.000Z" });
  assert.equal(quotaRows(ran(report))[0].readAt, NOW - 10 * MIN);
});

test("quotaRows doesn't date a stale reading without its time as new", () => {
  // Plain `quota-axi --json` drops state.refreshedAt unless the reading was reused, so a
  // cached fallback after a failed read arrives as stale with no time of its own.
  const report = structuredClone(quota);
  report.providers[0].state = { status: "stale", stale: true };
  const [claude] = quotaRows(ran(report));
  assert.equal(claude.readAt, null);
  assert.deepEqual(claude.weekly, { left: 38, resetAt: Date.parse("2026-11-13T19:00:00Z") });
  assert.equal(age(claude, NOW), "old");
  assert.match(tip(claude, NOW), /Read at an unknown time\.$/);
});

test("quotaRows says unavailable, with the reason, instead of guessing", () => {
  const reasons = (/** @type {import("../mods/herdr-token-viewer/usage.js").Ran} */ r) => quotaRows(r).map((row) => row.reason);
  assert.deepEqual(reasons(null), ["quota-axi could not be run", "quota-axi could not be run"]);
  assert.deepEqual(reasons({ code: 0, stdout: "" }), ["quota-axi printed no reading", "quota-axi printed no reading"]);
  assert.deepEqual(reasons({ code: 2, stdout: "boom" }), ["quota-axi failed (exit 2)", "quota-axi failed (exit 2)"]);

  const report = structuredClone(quota);
  report.providers[0].state = { status: "auth_required", stale: false };
  Object.assign(report.providers[1], { notSetUp: true });
  // A valid report is read even when the program exits non-zero for a provider it couldn't read.
  const rows = quotaRows(ran(report, 1));
  assert.deepEqual(rows[0], unavailable("claude", "Claude", "sign-in needed"));
  assert.deepEqual(rows[1], unavailable("gemini", "Gemini", "not set up on this Mac"));

  report.providers = [{ provider: "claude", state: { status: "fresh", stale: false }, windows: [{ id: "model:fable", percentRemaining: 77 }] }];
  assert.deepEqual(reasons(ran(report)), ["no 5-hour or weekly window reported", "not set up on this Mac"]);
});

test("quotaRows keeps the window it has when the other is missing", () => {
  const report = structuredClone(quota);
  report.providers[0].windows = [{ id: "seven_day", kind: "weekly", percentRemaining: 140.2, resetsAt: "not a date" }];
  const [claude] = quotaRows(ran(report));
  assert.equal(claude.fiveHour, null);
  assert.deepEqual(claude.weekly, { left: 100, resetAt: null });
});

test("codexRows lists every account in order, with what is left of each window", () => {
  const rows = codexRows(ran(limits));
  assert.deepEqual(rows.map((r) => r.name), ["Codex 1", "Codex 2", "Codex 3"]);
  assert.deepEqual(rows.map((r) => r.current), [false, false, true]);
  assert.deepEqual(rows[0], {
    id: "codex:Account 1 (Example Team [id:ab12c0], ex***@***.com, id:ab12c0)", name: "Codex 1",
    label: "Account 1 (Example Team [id:ab12c0], ex***@***.com, id:ab12c0)", current: false, enabled: true,
    plan: "team", readAt: NOW - 46 * MIN,
    fiveHour: { left: 88, resetAt: NOW + 4 * HOUR + 14 * MIN },
    weekly: { left: 5, resetAt: NOW + 26 * HOUR },
  });
});

test("codexRows goes by each window's length, not its position", () => {
  const weekOnly = account(0, { quota: { updatedAt: NOW, status: 200, primary: { usedPercent: 30, windowMinutes: 10080, resetAtMs: NOW + HOUR } } });
  const [row] = codexRows(ran({ accounts: [weekOnly] }));
  assert.equal(row.fiveHour, null);
  assert.deepEqual(row.weekly, { left: 70, resetAt: NOW + HOUR });

  const odd = account(0, { quota: { updatedAt: NOW, status: 200, primary: { usedPercent: 30, windowMinutes: 60, resetAtMs: NOW + HOUR } } });
  assert.equal(codexRows(ran({ accounts: [odd] }))[0].reason, "no 5-hour or weekly window reported");
});

test("codexRows shows a rate-limited account's windows", () => {
  // codex-multi-auth caches a 429 answer with its quota headers and lists it as rate-limited.
  const exhausted = account(1, { quota: {
    updatedAt: NOW - 5 * MIN, status: 429, planType: "team",
    primary: { usedPercent: 40, windowMinutes: 300, resetAtMs: NOW + HOUR },
    secondary: { usedPercent: 100, windowMinutes: 10080, resetAtMs: NOW + 50 * HOUR },
  } });
  const [row] = codexRows(ran({ accounts: [exhausted] }));
  assert.equal(row.reason, undefined);
  assert.deepEqual(row.fiveHour, { left: 60, resetAt: NOW + HOUR });
  assert.deepEqual(row.weekly, { left: 0, resetAt: NOW + 50 * HOUR });
  assert.deepEqual(tightest(row, NOW), { text: "0%", level: "low" });
});

test("codexRows says unavailable for an account without a reading, and when the program fails", () => {
  const rows = codexRows(ran({ accounts: [account(0), account(1, { quota: undefined, enabled: false })] }));
  assert.equal(rows[1].reason, "no reading yet");
  assert.equal(rows[1].enabled, false);
  assert.equal(rows[1].name, "Codex 2");
  assert.equal(age(rows[1], NOW), null);

  assert.deepEqual(codexRows(null), [unavailable("codex", "Codex", "codex-multi-auth could not be run")]);
  assert.deepEqual(codexRows({ code: 1, stdout: "" }), [unavailable("codex", "Codex", "codex-multi-auth failed (exit 1)")]);
  assert.deepEqual(codexRows(ran({ accounts: [] })), [unavailable("codex", "Codex", "no Codex accounts listed")]);
});

test("codexRows falls back to the account's place when it has no label or index", () => {
  const [row] = codexRows(ran({ accounts: [{ quota: account(0).quota }] }));
  assert.equal(row.id, "codex:0");
  assert.equal(row.name, "Codex 1");
});

test("span is short at every size", () => {
  assert.equal(span(-5), "<1m");
  assert.equal(span(59999), "<1m");
  assert.equal(span(42 * MIN), "42m");
  assert.equal(span(4 * HOUR + 5 * MIN), "4h05m");
  assert.equal(span(23 * HOUR + 59 * MIN), "23h59m");
  assert.equal(span(51 * HOUR + 20 * MIN), "2d3h");
  assert.equal(span(96 * HOUR + 59 * MIN), "4d");
});

test("cell shows the share left, the time to the reset and a level", () => {
  assert.deepEqual(cell({ left: 84.4, resetAt: NOW + 3 * HOUR + 40 * MIN }, NOW), { percent: "84%", reset: "3h40m", left: 84.4, level: "ok" });
  assert.equal(cell({ left: 24.9, resetAt: null }, NOW).level, "warn");
  assert.equal(cell({ left: 25, resetAt: null }, NOW).level, "ok");
  assert.equal(cell({ left: 9.9, resetAt: null }, NOW).level, "low");
  assert.deepEqual(cell({ left: 0, resetAt: null }, NOW), { percent: "0%", reset: "", left: 0, level: "low" });
  assert.deepEqual(cell(null, NOW), { percent: "–", reset: "", left: null, level: "none" });
});

test("cell drops a share that was read before its window reset", () => {
  assert.deepEqual(cell({ left: 5, resetAt: NOW - MIN }, NOW), { percent: "–", reset: "reset", left: null, level: "none" });
  assert.deepEqual(cell({ left: 5, resetAt: NOW }, NOW), { percent: "–", reset: "reset", left: null, level: "none" });
});

test("age speaks up only once a reading is older than a refresh", () => {
  const [row] = codexRows(ran(limits));
  assert.equal(age(row, NOW), "46m");
  assert.equal(age({ ...row, readAt: NOW - STALE_MS + 1 }, NOW), null);
  assert.equal(age({ ...row, readAt: NOW - STALE_MS }, NOW), "3m");
  assert.equal(age({ ...row, readAt: NOW - 7 * HOUR - 59 * MIN }, NOW), "7h");
  assert.equal(age({ ...row, readAt: NOW - 49 * HOUR }, NOW), "2d");
  assert.equal(age({ ...row, readAt: null }, NOW), "old");
  assert.equal(age(pendingRows().codex[0], NOW), null);
});

test("tightest picks the smaller share for the folded sidebar", () => {
  const [row] = codexRows(ran(limits));
  assert.deepEqual(tightest(row, NOW), { text: "5%", level: "low" });
  assert.deepEqual(tightest({ ...row, weekly: null }, NOW), { text: "88%", level: "ok" });
  // The weekly window reset since the reading, so only the 5-hour one still counts.
  assert.deepEqual(tightest({ ...row, weekly: { left: 5, resetAt: NOW + HOUR } }, NOW + 2 * HOUR), { text: "88%", level: "ok" });
  assert.deepEqual(tightest(unavailable("codex", "Codex", "x"), NOW), { text: "–", level: "none" });
});

test("clock is local time with the weekday", () => {
  assert.equal(clock(new Date(2026, 10, 12, 14, 5).getTime()), "Thu 14:05");
  assert.equal(clock(new Date(2026, 10, 15, 0, 0).getTime()), "Sun 00:00");
});

test("tip spells the row out", () => {
  const at = new Date(2026, 10, 12, 10, 30).getTime();
  /** @type {import("../mods/herdr-token-viewer/usage.js").Row} */
  const row = {
    id: "claude", name: "Claude", plan: "max", readAt: at - 30000,
    fiveHour: { left: 84, resetAt: at + 3 * HOUR + 40 * MIN }, weekly: { left: 38, resetAt: at + 41 * HOUR + 30 * MIN },
  };
  assert.equal(tip(row, at), "Claude, max plan. 5-hour: 84% left, resets Thu 14:10. Weekly: 38% left, resets Sat 04:00. Read <1m ago.");
  assert.equal(
    tip({ ...row, label: "Account 3 (ex***@***.com)", current: true, weekly: null, fiveHour: { left: 5, resetAt: at - HOUR }, readAt: at - 2 * HOUR }, at),
    "Account 3 (ex***@***.com), in use, max plan. 5-hour: reset Thu 09:30, after this reading. Weekly: not reported. Read 2h00m ago.",
  );
  assert.equal(tip({ ...unavailable("gemini", "Gemini", "sign-in needed") }, at), "Gemini: unavailable, sign-in needed.");
  assert.equal(tip({ ...unavailable("codex:1", "Codex 2", "no reading yet"), enabled: false }, at), "Codex 2, disabled: unavailable, no reading yet.");
  assert.equal(tip(pendingRows().codex[0], at), "Codex: reading…");
});

test("pendingRows stands in for all three until the first read", () => {
  const { quota: q, codex } = pendingRows();
  assert.deepEqual([...q, ...codex].map((r) => [r.name, r.pending]), [["Claude", true], ["Gemini", true], ["Codex", true]]);
});
