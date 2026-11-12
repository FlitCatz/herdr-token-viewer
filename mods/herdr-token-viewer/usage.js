// Reading rules for the usage rows: what the two programs print becomes rows, and rows
// become the short texts the sidebar shows. Pure functions, no imports, so `node --test`
// runs them without Herdr.

/** One quota window: the share still left (0..100) and when it resets (ms), if known. */
/** @typedef {{ left: number, resetAt: number | null }} Win */
/**
 * One line of the list. `reason` set means there is no reading to show; `pending` means
 * the first read hasn't come back yet.
 * @typedef {{
 *   id: string, name: string, fiveHour: Win | null, weekly: Win | null, readAt: number | null,
 *   plan?: string, label?: string, current?: boolean, enabled?: boolean,
 *   reason?: string, pending?: boolean,
 * }} Row
 */
/** What the program gave back: its exit code and output, or null when it couldn't run. */
/** @typedef {{ code: number, stdout: string } | null} Ran */
/** @typedef {"ok" | "warn" | "low" | "none"} Level */

export const QUOTA_AXI = "quota-axi";
export const CODEX_MULTI_AUTH = "codex-multi-auth";

// A reading older than this shows its age in the row. Longer than one refresh, so a
// reading that is simply waiting for the next refresh doesn't flicker "2m".
export const STALE_MS = 3 * 60000;

const WARN_BELOW = 25;
const LOW_BELOW = 10;
const FIVE_HOURS_MIN = 300;
const WEEK_MIN = 10080;

// Which quota-axi provider and window ids make each row. quota-axi lists more windows
// (per-model ones); only the plain 5-hour and weekly ones are shown.
const QUOTA_ROWS = [
  { id: "claude", name: "Claude", provider: "claude", fiveHour: "five_hour", weekly: "seven_day" },
  { id: "gemini", name: "Gemini", provider: "agy", fiveHour: "gemini_5h", weekly: "gemini_weekly" },
];

// quota-axi's own words for a provider it couldn't read, said the way the tooltip says them.
const STATE_REASONS = {
  unavailable: "no reading available",
  auth_required: "sign-in needed",
  rate_limited: "rate limited, try later",
  error: "the read failed",
};

/**
 * @param {string} id
 * @param {string} name
 * @param {string} reason
 * @returns {Row}
 */
export function unavailable(id, name, reason) {
  return { id, name, fiveHour: null, weekly: null, readAt: null, reason };
}

/** The rows shown before the first read comes back. @returns {{ quota: Row[], codex: Row[] }} */
export function pendingRows() {
  /** @type {(id: string, name: string) => Row} */
  const row = (id, name) => ({ id, name, fiveHour: null, weekly: null, readAt: null, pending: true });
  return { quota: QUOTA_ROWS.map((r) => row(r.id, r.name)), codex: [row("codex", "Codex")] };
}

/** @param {unknown} value @returns {number | null} a finite number, else null */
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** @param {unknown} value @returns {number | null} ms from an ISO time or a ms number */
function time(value) {
  if (typeof value === "number") return num(value);
  if (typeof value !== "string") return null;
  // quota-axi prints microseconds for some windows; only milliseconds are standard to parse.
  const ms = Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isFinite(ms) ? ms : null;
}

/** @param {number} percent @returns {number} */
function clamp(percent) {
  return Math.min(100, Math.max(0, percent));
}

/** @param {string | undefined | null} text @returns {any} the parsed JSON object, else null */
function json(text) {
  try {
    const value = JSON.parse(text ?? "");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Why a program gave nothing usable.
 * @param {string} program
 * @param {Ran} ran
 */
function failure(program, ran) {
  if (!ran) return `${program} could not be run`;
  return ran.code === 0 ? `${program} printed no reading` : `${program} failed (exit ${ran.code})`;
}

/**
 * Claude and Gemini rows from `quota-axi --provider claude,agy --json`.
 * @param {Ran} ran
 * @returns {Row[]}
 */
export function quotaRows(ran) {
  const report = json(ran?.stdout);
  const providers = Array.isArray(report?.providers) ? report.providers : null;
  if (!providers) return QUOTA_ROWS.map((r) => unavailable(r.id, r.name, failure(QUOTA_AXI, ran)));
  const generatedAt = time(report.generatedAt);
  return QUOTA_ROWS.map((r) => {
    const p = providers.find((/** @type {any} */ x) => x?.provider === r.provider);
    if (!p || p.notSetUp) return unavailable(r.id, r.name, "not set up on this Mac");
    const status = p.state?.status;
    if (status !== "fresh" && status !== "stale") {
      return unavailable(r.id, r.name, STATE_REASONS[/** @type {keyof typeof STATE_REASONS} */ (status)] ?? "no reading available");
    }
    const windows = Array.isArray(p.windows) ? p.windows : [];
    /** @type {(id: string) => Win | null} */
    const win = (id) => {
      const w = windows.find((/** @type {any} */ x) => x?.id === id);
      const left = num(w?.percentRemaining);
      return left === null ? null : { left: clamp(left), resetAt: time(w.resetsAt) };
    };
    const fiveHour = win(r.fiveHour);
    const weekly = win(r.weekly);
    if (!fiveHour && !weekly) return unavailable(r.id, r.name, "no 5-hour or weekly window reported");
    // A reused reading says when it was taken; a fresh one was taken just now. A stale one
    // without its time is of unknown age, not new.
    const readAt = time(p.state?.refreshedAt) ?? (status === "fresh" ? generatedAt : null);
    return { id: r.id, name: r.name, fiveHour, weekly, readAt, plan: typeof p.plan === "string" ? p.plan : undefined };
  });
}

/**
 * One row per Codex account from `codex-multi-auth limits --json`, in its order. The
 * account's masked label is its identity, so a row keeps its place in the list while the
 * accounts rotate.
 * @param {Ran} ran
 * @returns {Row[]}
 */
export function codexRows(ran) {
  const report = json(ran?.stdout);
  const accounts = Array.isArray(report?.accounts) ? report.accounts : null;
  if (!accounts) return [unavailable("codex", "Codex", failure(CODEX_MULTI_AUTH, ran))];
  if (!accounts.length) return [unavailable("codex", "Codex", "no Codex accounts listed")];
  return accounts.map((/** @type {any} */ a, /** @type {number} */ i) => {
    const index = num(a?.index) ?? i;
    const label = typeof a?.label === "string" && a.label ? a.label : undefined;
    const id = `codex:${label ?? index}`;
    const name = `Codex ${index + 1}`;
    const about = { label, current: a?.current === true, enabled: a?.enabled !== false };
    const q = a?.quota;
    if (!q) return { ...unavailable(id, name, "no reading yet"), ...about };
    /** @type {(minutes: number) => Win | null} */
    const win = (minutes) => {
      const w = [q.primary, q.secondary].find((x) => num(x?.windowMinutes) === minutes);
      const used = num(w?.usedPercent);
      return used === null ? null : { left: clamp(100 - used), resetAt: num(w.resetAtMs) };
    };
    const fiveHour = win(FIVE_HOURS_MIN);
    const weekly = win(WEEK_MIN);
    if (!fiveHour && !weekly) return { ...unavailable(id, name, "no 5-hour or weekly window reported"), ...about };
    return { id, name, fiveHour, weekly, readAt: num(q.updatedAt), plan: typeof q.planType === "string" ? q.planType : undefined, ...about };
  });
}

/**
 * A length of time, short: `<1m`, `42m`, `4h05m`, `2d3h`, `4d`.
 * @param {number} ms
 */
export function span(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d` + (h % 24 ? `${h % 24}h` : "");
}

/**
 * Whether the window has reset since it was read: the share read then says nothing now.
 * @param {Win} win
 * @param {number} now
 */
function passed(win, now) {
  return win.resetAt !== null && win.resetAt <= now;
}

/** @param {number} left @returns {Level} */
function level(left) {
  return left < LOW_BELOW ? "low" : left < WARN_BELOW ? "warn" : "ok";
}

/**
 * One window as the row shows it: the share left, the time to the reset, and how full
 * to draw the bar (null: no bar).
 * @param {Win | null} win
 * @param {number} now
 * @returns {{ percent: string, reset: string, left: number | null, level: Level }}
 */
export function cell(win, now) {
  if (!win) return { percent: "–", reset: "", left: null, level: "none" };
  if (passed(win, now)) return { percent: "–", reset: "reset", left: null, level: "none" };
  return {
    percent: `${Math.round(win.left)}%`,
    reset: win.resetAt === null ? "" : span(win.resetAt - now),
    left: win.left,
    level: level(win.left),
  };
}

/**
 * The reading's age, when it is old enough to say, else null. It sits beside the name, so
 * it is one unit only: `46m`, `7h`, `2d`, or `old` for a reading of unknown time.
 * @param {Row} row
 * @param {number} now
 */
export function age(row, now) {
  if (row.pending || row.reason) return null;
  if (row.readAt === null) return "old";
  if (now - row.readAt < STALE_MS) return null;
  const m = Math.floor((now - row.readAt) / 60000);
  if (m < 60) return `${m}m`;
  return m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

/**
 * The folded sidebar shows one number per row: the smaller share of its two windows.
 * @param {Row} row
 * @param {number} now
 * @returns {{ text: string, level: Level }}
 */
export function tightest(row, now) {
  const cells = [cell(row.fiveHour, now), cell(row.weekly, now)].filter((c) => c.left !== null);
  if (!cells.length) return { text: "–", level: "none" };
  const c = cells.reduce((a, b) => (b.left < a.left ? b : a));
  return { text: c.percent, level: c.level };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A moment in this machine's local time: `Thu 14:05`.
 * @param {number} ms
 */
export function clock(ms) {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The row in full, for its tooltip.
 * @param {Row} row
 * @param {number} now
 */
export function tip(row, now) {
  const who = [row.label ?? row.name, row.current ? "in use" : "", row.enabled === false ? "disabled" : "", row.plan ? `${row.plan} plan` : ""]
    .filter(Boolean).join(", ");
  if (row.pending) return `${who}: reading…`;
  if (row.reason) return `${who}: unavailable, ${row.reason}.`;
  /** @type {(title: string, win: Win | null) => string} */
  const part = (title, win) => {
    if (!win) return `${title}: not reported`;
    if (passed(win, now)) return `${title}: reset ${clock(win.resetAt)}, after this reading`;
    return `${title}: ${Math.round(win.left)}% left` + (win.resetAt === null ? "" : `, resets ${clock(win.resetAt)}`);
  };
  const read = row.readAt === null ? " Read at an unknown time." : ` Read ${span(now - row.readAt)} ago.`;
  return `${who}. ${part("5-hour", row.fiveHour)}. ${part("Weekly", row.weekly)}.${read}`;
}
