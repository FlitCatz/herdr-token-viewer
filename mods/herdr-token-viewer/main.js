import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, theme } from "herdr";
import { CODEX_MULTI_AUTH, QUOTA_AXI, age, cell, codexRows, pendingRows, quotaRows, tightest, tip } from "./usage.js";

/** @typedef {import("gpui-kit").Context} Context */
/** @typedef {import("gpui-kit").Color} Color */
/** @typedef {import("./usage.js").Row} Row */

// quota-axi asks each vendor on every read, and a copy keeps its timers while hidden, so
// the refresh stays slow. Countdowns and ages move by the minute between refreshes.
const REFRESH_MS = 120000;
const MINUTE_MS = 60000;
const EXEC_TIMEOUT_MS = 30000;

// The two programs read, each on its own so Codex's instant answer doesn't wait for
// quota-axi's network round trip. Both only read: quota-axi is told not to renew a
// session, and `limits` without --refresh prints what codex-multi-auth last saw.
const SOURCES = {
  quota: {
    command: QUOTA_AXI,
    // --max-age lets several windows share one vendor read.
    args: ["--provider", "claude,agy", "--json", "--no-credential-refresh", "--max-age", "60s"],
    rows: quotaRows,
  },
  codex: { command: CODEX_MULTI_AUTH, args: ["limits", "--json"], rows: codexRows },
};

// Below this width the sidebar is its folded rail and each row is one number.
const RAIL_BELOW = 160;
// Sized so "Codex 3", its in-use dot and a two-digit age fit beside both windows at the
// sidebar's usual 268 px.
const CELL_W = 68;
const GAP = 6;
const PAD = 14;

export default class TokenViewer extends View {
  /**
   * @param {unknown} _props
   * @param {Context} cx
   */
  init(_props, cx) {
    this.rows = pendingRows();
    /** @type {Set<string>} sources with a read in flight */
    this.reading = new Set();
    this.width = Infinity;
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    cx.timer.every(MINUTE_MS, (cx) => cx.notify());
    this.refresh(cx);
  }

  /** @param {Context} cx */
  refresh(cx) {
    for (const key of /** @type {(keyof typeof SOURCES)[]} */ (Object.keys(SOURCES))) {
      if (this.reading.has(key)) continue;
      this.reading.add(key);
      const source = SOURCES[key];
      cx.spawn(async (cx) => {
        // A program that is missing or hangs past the timeout leaves null, which the row
        // rules turn into "unavailable" rows, as they do output they can't read. Nothing
        // is kept from an earlier read to stand in for it.
        /** @type {import("./usage.js").Ran} */
        let ran = null;
        try { ran = await exec(source.command, source.args, { timeout: EXEC_TIMEOUT_MS }); } catch { /* stays null */ }
        this.rows[key] = source.rows(ran);
        this.reading.delete(key);
        cx.notify();
      });
    }
  }

  /**
   * @param {Record<string, Color>} t
   * @param {import("./usage.js").Level} level
   */
  color(t, level) {
    return level === "low" ? t.blocked : level === "warn" ? t.working : level === "ok" ? t.foreground : t.dim;
  }

  /**
   * One window: the share left and the time to its reset, over a thin bar.
   * @param {Record<string, Color>} t
   * @param {import("./usage.js").Win | null} win
   * @param {number} now
   */
  cell(t, win, now) {
    const c = cell(win, now);
    return v_flex().w(CELL_W).flex_none().gap(3)
      .child(h_flex().items_center().justify_between()
        .child(div().text_size(11.5).font_medium().text_color(this.color(t, c.level)).child(c.percent))
        .child(div().text_size(10.5).text_color(t.dim).child(c.reset)))
      .child(div().h(2).w_full().rounded(1).bg(t.border)
        .when(c.left !== null, (el) => el.child(div().h_full().rounded(1).w(`${Math.round(c.left)}%`)
          .bg(c.level === "ok" ? t.muted : this.color(t, c.level)))));
  }

  /**
   * @param {Record<string, Color>} t
   * @param {Row} row
   * @param {number} now
   */
  row(t, row, now) {
    const old = age(row, now);
    const missing = row.pending || Boolean(row.reason);
    return h_flex().id(`usage-${row.id}`).h(26).flex_none().gap(GAP).items_center().tooltip(tip(row, now))
      .child(h_flex().flex_1().min_w(0).gap(4).items_center()
        .child(div().truncate().text_color(row.enabled === false || missing ? t.muted : t.foreground).child(row.name))
        // The Codex account codex-multi-auth is using now.
        .when(row.current === true, (el) => el.child(div().size(5).flex_none().rounded_full().bg(t.accent)))
        .when(Boolean(old), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(old))))
      .when(missing, (el) => el.child(div().w(CELL_W * 2 + GAP).flex_none().text_size(11.5).text_color(t.dim)
        .child(row.pending ? "reading…" : "unavailable")))
      .when(!missing, (el) => el.child(this.cell(t, row.fiveHour, now)).child(this.cell(t, row.weekly, now)));
  }

  /**
   * The folded sidebar: the row's initial (and Codex account number) and its tighter window.
   * @param {Record<string, Color>} t
   * @param {Row} row
   * @param {number} now
   */
  railRow(t, row, now) {
    const tight = tightest(row, now);
    const short = row.name[0] + (/\d+$/.exec(row.name)?.[0] ?? "");
    return h_flex().id(`usage-${row.id}`).h(26).flex_none().gap(3).items_center().justify_center().text_size(10.5).tooltip(tip(row, now))
      .child(div().text_color(t.dim).child(short))
      .child(div().font_medium().text_color(this.color(t, tight.level)).child(tight.text));
  }

  render() {
    const t = /** @type {Record<string, Color>} */ (theme());
    const now = Date.now();
    const [claude, fable, gemini, argon] = this.rows.quota;
    const rows = [claude, fable, ...this.rows.codex, gemini, argon];
    const rail = this.width < RAIL_BELOW;
    const head = (/** @type {string} */ label) => div().w(CELL_W).flex_none().text_size(10.5).text_color(t.dim).child(label);
    return v_flex().id("root").size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(12.5)
      .on_size_change((size, cx) => {
        this.width = size.width;
        cx.notify();
      })
      .when(!rail, (el) => el.child(h_flex().id("usage-head").px(PAD).h(36).pt(12).pb(4).flex_none().gap(GAP).items_center()
        .tooltip("Remaining usage per 5-hour and weekly window, with the time to each reset.")
        .child(div().flex_1().text_size(11.5).font_medium().text_color(t.dim).child("Usage"))
        .child(head("5h"))
        .child(head("Week"))))
      .child(v_flex().id("usage-rows").flex_1().min_h(0).px(rail ? 0 : PAD).pt(rail ? 6 : 0).overflow_y_scrollbar()
        .children(rows.map((row) => (rail ? this.railRow(t, row, now) : this.row(t, row, now)))));
  }
}
