import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Stub only the Herdr runtime boundary ("gpui-kit", "gpui-base", "herdr") so the real
// view module runs under `node --test` without a Herdr host.
const runtime = {
  checking: false,
  /** @type {(cmd: string, args: string[], opts: unknown) => Promise<{ code: number, stdout: string } | null>} */
  exec: async () => null,
  theme: {
    chrome: "#111111",
    border: "#222222",
    foreground: "#eeeeee",
    muted: "#888888",
    dim: "#666666",
    accent: "#0088ff",
    working: "#ffaa00",
    blocked: "#ff3333",
  },
};

/** @param {string} kind */
function makeElement(kind) {
  /** @type {{ kind: string, props: Record<string, any>, items: any[] }} */
  const node = { kind, props: {}, items: [] };
  /** @type {any} */
  const el = new Proxy(node, {
    get(target, prop) {
      if (prop === "child") {
        return (/** @type {any} */ c) => {
          target.items.push(c);
          return el;
        };
      }
      if (prop === "children") {
        return (/** @type {any[]} */ cs) => {
          target.items.push(...cs);
          return el;
        };
      }
      if (prop === "when") {
        return (/** @type {boolean} */ cond, /** @type {(x: any) => void} */ fn) => {
          if (cond) fn(el);
          return el;
        };
      }
      if (prop in target) return target[/** @type {keyof typeof target} */ (prop)];
      return (/** @type {any[]} */ ...args) => {
        target.props[String(prop)] = args.length <= 1 ? (args[0] ?? true) : args;
        return el;
      };
    },
  });
  return el;
}

const g = /** @type {any} */ (globalThis);
g.__herdrTestRuntime = runtime;
g.__herdrTestMakeElement = makeElement;

const STUBS = {
  "gpui-kit": `
    export class View {}
    export const div = () => globalThis.__herdrTestMakeElement("div");
  `,
  "gpui-base": `
    export const h_flex = () => globalThis.__herdrTestMakeElement("h_flex");
    export const v_flex = () => globalThis.__herdrTestMakeElement("v_flex");
  `,
  herdr: `
    export const checking = () => globalThis.__herdrTestRuntime.checking;
    export const exec = (...args) => globalThis.__herdrTestRuntime.exec(...args);
    export const theme = () => globalThis.__herdrTestRuntime.theme;
  `,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier in STUBS) {
      return { url: `herdr-stub:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("herdr-stub:")) {
      const key = url.slice("herdr-stub:".length);
      return {
        format: "module",
        source: STUBS[/** @type {keyof typeof STUBS} */ (key)],
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

/** @param {any} node @returns {string[]} */
function texts(node) {
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (!node || !Array.isArray(node.items)) return [];
  return node.items.flatMap(texts);
}

/** @param {any} node @param {string} id @returns {any} */
function findById(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.props?.id === id) return node;
  if (!Array.isArray(node.items)) return null;
  for (const child of node.items) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

/**
 * Sum horizontal fixed pixels required by a full row (or header) inside its container:
 * container left+right padding, every child's numeric fixed `w`, and `gap` between children.
 * @param {any} rowNode
 * @param {number} padX
 */
function fixedRowWidth(rowNode, padX) {
  const fixedCols = rowNode.items.reduce(
    (/** @type {number} */ sum, /** @type {any} */ child) => sum + (typeof child?.props?.w === "number" ? child.props.w : 0),
    0,
  );
  const gap = typeof rowNode.props?.gap === "number" ? rowNode.props.gap : 0;
  const gaps = Math.max(0, rowNode.items.length - 1) * gap;
  return padX * 2 + fixedCols + gaps;
}

/** Load a fresh view module instance so each test has its own isolated shared feed. */
async function loadView(tag) {
  const mod = await import(`../mods/herdr-token-viewer/main.js?case=${tag}`);
  return mod.default;
}

function makeCx() {
  let notifications = 0;
  /** @type {Array<{ cancel(): void }>} */
  const timers = [];
  return {
    get notifications() { return notifications; },
    notify() { notifications += 1; },
    timer: {
      every() {
        const handle = { cancelled: false, cancel() { this.cancelled = true; } };
        timers.push(handle);
        return handle;
      },
      after() {
        const handle = { cancelled: false, cancel() { this.cancelled = true; } };
        timers.push(handle);
        return handle;
      },
    },
    spawn(/** @type {(cx: any) => unknown} */ fn) {
      void Promise.resolve().then(() => fn(this));
      return { cancel() {} };
    },
    timers,
  };
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

test("full mode only turns on when fixed columns and minimum name width fit inside the block", async () => {
  const now = Date.now();
  const MIN = 60000;
  const HOUR = 60 * MIN;
  runtime.checking = false;
  runtime.exec = async (cmd) => {
    if (cmd === "quota-axi") {
      return {
        code: 0,
        stdout: JSON.stringify({
          generatedAt: new Date(now).toISOString(),
          providers: [
            {
              provider: "claude", plan: "max", state: { status: "fresh" },
              windows: [
                { id: "five_hour", percentRemaining: 84, resetsAt: new Date(now + 3 * HOUR).toISOString() },
                { id: "seven_day", percentRemaining: 38, resetsAt: new Date(now + 30 * HOUR).toISOString() },
                { id: "model:fable", percentRemaining: 77, resetsAt: new Date(now + 30 * HOUR).toISOString() },
              ],
            },
            { provider: "agy", notSetUp: true },
          ],
        }),
      };
    }
    return {
      code: 0,
      stdout: JSON.stringify({
        accounts: [
          {
            index: 0, enabled: true, current: true, label: "Account 1 (ex***@***.com)",
            quota: {
              updatedAt: now - 46 * MIN,
              primary: { usedPercent: 12, windowMinutes: 300, resetAtMs: now + 4 * HOUR },
              secondary: { usedPercent: 95, windowMinutes: 10080, resetAtMs: now + 26 * HOUR },
            },
          },
        ],
      }),
    };
  };

  const TokenViewer = await loadView("width-boundary");
  const cx = makeCx();
  const view = new TokenViewer();
  view.init({}, cx);
  await flush();

  const initial = view.render();
  const onSizeChange = initial.props.on_size_change;
  assert.equal(typeof onSizeChange, "function");

  /** @param {number} width */
  const renderAt = (width) => {
    onSizeChange({ width, height: 200 }, cx);
    return view.render();
  };

  // At 165 px (formerly full mode), 176 px (fixed columns alone), and 259 px, the view stays in rail mode.
  for (const narrow of [165, 176, 200, 235, 259]) {
    const tree = renderAt(narrow);
    assert.equal(findById(tree, "usage-head"), null, `expected rail mode at ${narrow}px`);
    const rowsEl = findById(tree, "usage-rows");
    assert.equal(rowsEl.props.px, 0, `expected rail padding at ${narrow}px`);
  }

  // Once the block reaches 260 px (and at Herdr's standard 268 px), full mode turns on
  // with fixed columns + padding leaving at least 84 px for the name, in-use dot, and age.
  for (const wide of [260, 268]) {
    const tree = renderAt(wide);
    const head = findById(tree, "usage-head");
    assert.ok(head, `expected full header at ${wide}px`);
    const headFixed = fixedRowWidth(head, head.props.px);
    assert.ok(wide - headFixed >= 84, `header fixed width ${headFixed} leaves < 84px at ${wide}px`);

    const rowsEl = findById(tree, "usage-rows");
    assert.deepEqual(
      rowsEl.items.map((/** @type {any} */ el) => el.props.id),
      ["usage-claude", "usage-fable", "usage-codex:0", "usage-gemini"],
    );
    for (const rowEl of rowsEl.items) {
      const rowFixed = fixedRowWidth(rowEl, rowsEl.props.px);
      assert.ok(wide - rowFixed >= 84, `row ${rowEl.props.id} fixed width ${rowFixed} leaves < 84px at ${wide}px`);
    }
  }

  view.close();
});

test("two Codex accounts with identical masked labels render with unique element ids", async () => {
  const now = Date.now();
  const HOUR = 3600000;
  const sameLabel = "Shared Team (ex***@***.com)";
  runtime.checking = false;
  runtime.exec = async (cmd) => {
    if (cmd === "quota-axi") {
      return { code: 0, stdout: JSON.stringify({ generatedAt: new Date(now).toISOString(), providers: [] }) };
    }
    return {
      code: 0,
      stdout: JSON.stringify({
        accounts: [
          {
            index: 0, enabled: true, current: false, label: sameLabel,
            quota: { updatedAt: now, primary: { usedPercent: 10, windowMinutes: 300, resetAtMs: now + 2 * HOUR } },
          },
          {
            index: 1, enabled: true, current: true, label: sameLabel,
            quota: { updatedAt: now, primary: { usedPercent: 40, windowMinutes: 300, resetAtMs: now + 3 * HOUR } },
          },
        ],
      }),
    };
  };

  const TokenViewer = await loadView("unique-codex-ids");
  const cx = makeCx();
  const view = new TokenViewer();
  view.init({}, cx);
  await flush();

  const onSizeChange = view.render().props.on_size_change;
  for (const width of [268, 165]) {
    onSizeChange({ width, height: 200 }, cx);
    const rowsEl = findById(view.render(), "usage-rows");
    const ids = rowsEl.items.map((/** @type {any} */ el) => el.props.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate row ids at ${width}px: ${ids.join(", ")}`);
    const codexRowEls = rowsEl.items.filter((/** @type {any} */ el) => String(el.props.id).startsWith("usage-codex:"));
    assert.equal(codexRowEls.length, 2);
    assert.ok(codexRowEls.every((/** @type {any} */ el) => String(el.props.tooltip).startsWith(sameLabel)));
  }

  view.close();
});

test("view keeps the percentage when a Codex reading was taken after its reported resetAtMs", async () => {
  const now = Date.now();
  const HOUR = 3600000;
  runtime.checking = false;
  runtime.exec = async (cmd) => {
    if (cmd === "quota-axi") {
      return { code: 0, stdout: JSON.stringify({ generatedAt: new Date(now).toISOString(), providers: [] }) };
    }
    return {
      code: 0,
      stdout: JSON.stringify({
        accounts: [
          {
            index: 0, enabled: true, current: true, label: "Account 1 (ex***@***.com)",
            quota: {
              updatedAt: now,
              primary: { usedPercent: 20, windowMinutes: 300, resetAtMs: now - 1000 },
              secondary: { usedPercent: 30, windowMinutes: 10080, resetAtMs: now + 24 * HOUR },
            },
          },
        ],
      }),
    };
  };

  const TokenViewer = await loadView("conflicting-reset-view");
  const cx = makeCx();
  const view = new TokenViewer();
  view.init({}, cx);
  await flush();

  const codexRow = findById(view.render(), "usage-codex:0");
  assert.ok(codexRow);
  const renderedTexts = texts(codexRow);
  assert.ok(renderedTexts.includes("80%"), `expected 80% in row texts, got: ${JSON.stringify(renderedTexts)}`);
  assert.ok(!renderedTexts.includes("reset"), `did not expect reset in row texts, got: ${JSON.stringify(renderedTexts)}`);
  assert.match(codexRow.props.tooltip, /5-hour: 80% left\./);
  assert.doesNotMatch(codexRow.props.tooltip, /after this reading/);

  view.close();
});

test("view omits 'old' on a current agy reading marked stale and keeps 'old' on an untimed stale fallback", async () => {
  const now = Date.now();
  const HOUR = 3600000;
  let untimed = false;
  // A full report shaped like quota-axi 0.1.69 `--full --json`: a live agy read is marked
  // stale when an unrelated claude_gpt window reports an epoch reset.
  const fullReport = () => ({
    generatedAt: new Date(now).toISOString(),
    providers: [
      {
        provider: "claude", plan: "max", source: "oauth",
        attempts: [{ source: "oauth", status: "success" }],
        state: { status: "fresh", stale: false, refreshedAt: new Date(now - 1000).toISOString(), sourcesTried: ["oauth"] },
        windows: [
          { id: "five_hour", percentRemaining: 84, resetsAt: new Date(now + 3 * HOUR).toISOString() },
          { id: "seven_day", percentRemaining: 38, resetsAt: new Date(now + 30 * HOUR).toISOString() },
          { id: "model:fable", percentRemaining: 77, resetsAt: new Date(now + 30 * HOUR).toISOString() },
        ],
      },
      untimed
        ? {
          provider: "agy",
          source: "cache",
          attempts: [{ source: "cli", status: "failed", error: "timeout" }],
          state: { status: "stale", stale: true, error: "timeout", sourcesTried: ["cli", "cache"] },
          windows: [
            { id: "gemini_5h", percentRemaining: 81, resetsAt: new Date(now + 4 * HOUR).toISOString() },
            { id: "gemini_weekly", percentRemaining: 19, resetsAt: new Date(now + 120 * HOUR).toISOString() },
          ],
        }
        : {
          provider: "agy",
          source: "cli",
          attempts: [{ source: "cli", status: "success" }],
          state: { status: "stale", stale: true, refreshedAt: new Date(now - 500).toISOString(), sourcesTried: ["cli"] },
          windows: [
            { id: "gemini_5h", percentRemaining: 81, resetsAt: new Date(now + 4 * HOUR).toISOString() },
            { id: "gemini_weekly", percentRemaining: 19, resetsAt: new Date(now + 120 * HOUR).toISOString() },
            { id: "claude_gpt_5h", percentRemaining: 100, resetsAt: "1970-01-01T00:00:00.000Z" },
          ],
        },
    ],
  });
  // Plain `--json` (quota-axi render.js quotaJsonReport) drops source, attempts and
  // sourcesTried, and keeps state.refreshedAt only for a reused reading.
  /** @param {any} report */
  const compact = (report) => ({
    ...report,
    providers: report.providers.map((/** @type {any} */ p) => ({
      ...p,
      source: undefined,
      attempts: undefined,
      state: { ...p.state, refreshedAt: p.state.reused ? p.state.refreshedAt : undefined, sourcesTried: undefined },
    })),
  });
  runtime.checking = false;
  runtime.exec = async (cmd, args) => {
    if (cmd === "quota-axi") {
      const report = fullReport();
      return { code: 0, stdout: JSON.stringify(args.includes("--full") ? report : compact(report)) };
    }
    return { code: 0, stdout: JSON.stringify({ accounts: [] }) };
  };

  const TokenViewer = await loadView("gemini-live-stale-view");
  const view = new TokenViewer();
  view.init({}, makeCx());
  await flush();

  const geminiLive = findById(view.render(), "usage-gemini");
  assert.ok(geminiLive);
  const liveTexts = texts(geminiLive);
  assert.ok(liveTexts.includes("81%"), `expected 81% in ${JSON.stringify(liveTexts)}`);
  assert.ok(!liveTexts.includes("old"), `did not expect 'old' in live Gemini row: ${JSON.stringify(liveTexts)}`);
  assert.match(geminiLive.props.tooltip, /Read <1m ago\.$/);

  view.close();

  // Untimed cached fallback still shows 'old' in the rendered row.
  untimed = true;
  const TokenViewerUntimed = await loadView("gemini-untimed-stale-view");
  const view2 = new TokenViewerUntimed();
  view2.init({}, makeCx());
  await flush();

  const geminiStale = findById(view2.render(), "usage-gemini");
  assert.ok(geminiStale);
  const staleTexts = texts(geminiStale);
  assert.ok(staleTexts.includes("old"), `expected 'old' in untimed stale Gemini row: ${JSON.stringify(staleTexts)}`);
  assert.match(geminiStale.props.tooltip, /Read at an unknown time\.$/);

  view2.close();
});
