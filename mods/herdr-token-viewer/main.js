import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { checking, exec, theme } from "herdr";
import { createFeed } from "./feed.js";
import { SOURCES, age, cell, pendingRows, rail, tip } from "./usage.js";

/** @typedef {import("gpui-kit").Context} Context */
/** @typedef {import("gpui-kit").Color} Color */
/** @typedef {import("./usage.js").Row} Row */

// quota-axi asks each vendor on every read, and codex-multi-auth refreshes each Codex
// account live on its own slower cadence; copies in this app share one feed so multiple
// views (visible or hidden) do not duplicate CLI invocations. Countdowns and ages move
// by the minute between refreshes.
const MINUTE_MS = 60000;
const feed = createFeed({ exec, sources: SOURCES, initialRows: pendingRows, minuteMs: MINUTE_MS });

// Sized so "Codex 3", its in-use dot and a two-digit age fit beside both windows at the
// sidebar's usual 268 px.
const CELL_W = 68;
const GAP = 6;
const PAD = 14;
// Minimum width kept for the row name (plus in-use dot and stale age) before folding to the rail.
const MIN_NAME_W = 84;
// Below this width the sidebar folds to its rail so fixed columns never crowd out the name.
const RAIL_BELOW = PAD * 2 + CELL_W * 2 + GAP * 2 + MIN_NAME_W;

export default class TokenViewer extends View {
  /**
   * @param {unknown} _props
   * @param {Context} cx
   */
  init(_props, cx) {
    this.width = Infinity;
    /** @type {(() => void) | null} */
    this.detach = null;
    // `herdr-app check` runs init() for real; it only proves the mod loads, so it must not
    // start quota-axi, codex-multi-auth, or shared background timers.
    if (!checking()) {
      const handle = feed.attach({
        every: (ms, fn) => cx.timer.every(ms, () => fn(), { owner: null }),
        after: (ms, fn) => cx.timer.after(ms, () => fn(), { owner: null }),
        spawn: (fn) => cx.spawn(() => fn(), { owner: null }),
      });
      this.detach = handle.detach;
      cx.spawn(async (cx) => {
        while (await handle.waitUpdate()) cx.notify();
      });
    }
  }

  close() {
    this.detach?.();
    this.detach = null;
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
   * @param {number} staleMs the row's source's `staleMs`
   */
  row(t, row, now, staleMs) {
    const old = age(row, now, staleMs);
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
   * The folded sidebar: the row's initial (and Codex account number), its tighter window,
   * and the reading's age when stale.
   * @param {Record<string, Color>} t
   * @param {Row} row
   * @param {number} now
   * @param {number} staleMs the row's source's `staleMs`
   */
  railRow(t, row, now, staleMs) {
    const r = rail(row, now, staleMs);
    const line = h_flex().gap(3).items_center().justify_center().text_size(10.5)
      .child(div().text_color(t.dim).child(r.short))
      .child(div().font_medium().text_color(this.color(t, r.level)).child(r.text));
    if (!r.age) {
      return line.id(`usage-${row.id}`).h(26).flex_none().tooltip(tip(row, now));
    }
    return v_flex().id(`usage-${row.id}`).min_h(26).py(2).flex_none().gap(1).items_center().justify_center().tooltip(tip(row, now))
      .child(line)
      .child(div().text_size(9).text_color(t.dim).child(r.age));
  }

  render() {
    const t = /** @type {Record<string, Color>} */ (theme());
    const now = Date.now();
    const [claude, fable, gemini] = feed.rows.quota.map((row) => ({ row, staleMs: SOURCES.quota.staleMs }));
    const rows = [claude, fable, ...feed.rows.codex.map((row) => ({ row, staleMs: SOURCES.codex.staleMs })), gemini];
    const isRail = this.width < RAIL_BELOW;
    const head = (/** @type {string} */ label) => div().w(CELL_W).flex_none().text_size(10.5).text_color(t.dim).child(label);
    return v_flex().id("root").size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(12.5)
      .on_size_change((size, cx) => {
        this.width = size.width;
        cx.notify();
      })
      .when(!isRail, (el) => el.child(h_flex().id("usage-head").px(PAD).h(36).pt(12).pb(4).flex_none().gap(GAP).items_center()
        .tooltip("Remaining usage per 5-hour and weekly window, with the time to each reset.")
        .child(div().flex_1().text_size(11.5).font_medium().text_color(t.dim).child("Usage"))
        .child(head("5h"))
        .child(head("Week"))))
      .child(v_flex().id("usage-rows").flex_1().min_h(0).px(isRail ? 0 : PAD).pt(isRail ? 6 : 0).overflow_y_scrollbar()
        .children(rows.map(({ row, staleMs }) => (isRail ? this.railRow(t, row, now, staleMs) : this.row(t, row, now, staleMs)))));
  }
}
