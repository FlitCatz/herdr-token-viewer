// Shared source polling across all copies of the view in this Herdr app. No Herdr
// imports so `node --test` drives it with stubs.

/** @typedef {import("./usage.js").Ran} Ran */
/** @typedef {import("./usage.js").Row} Row */
/**
 * @typedef {{
 *   command: string,
 *   args: string[],
 *   intervalMs: number,
 *   staleMs: number,
 *   timeoutMs: number,
 *   rows: (ran: Ran) => Row[],
 * }} Source
 */
/** @typedef {{ cancel(): void }} TimerTask */
/**
 * @typedef {{
 *   every: (ms: number, fn: () => void) => TimerTask,
 *   after: (ms: number, fn: () => void) => TimerTask,
 *   spawn: (fn: () => Promise<void> | void) => unknown,
 * }} Scheduler
 */

const MINUTE_MS = 60000;

/**
 * Create one shared feed for a map of usage sources.
 * @template {Record<string, Source>} S
 * @param {{
 *   exec: (command: string, args: string[], opts: { timeout: number }) => Promise<Ran>,
 *   sources: S,
 *   initialRows: () => Record<keyof S, Row[]>,
 *   now?: () => number,
 *   minuteMs?: number,
 * }} deps
 */
export function createFeed({ exec, sources, initialRows, now = Date.now, minuteMs = MINUTE_MS }) {
  const rows = initialRows();
  /** @type {Set<keyof S>} */
  const inFlight = new Set();
  /** @type {Map<keyof S, number>} */
  const lastStartedAt = new Map();
  /** @type {Set<TimerTask>} */
  const tasks = new Set();
  /**
   * @typedef {{
   *   scheduler: Scheduler,
   *   closed: boolean,
   *   dirty: boolean,
   *   resolve: ((alive: boolean) => void) | null,
   *   wake: () => void,
   *   waitUpdate: () => Promise<boolean>,
   *   close: () => void,
   * }} Listener
   */
  /** @type {Set<Listener>} */
  const listeners = new Set();
  /** @type {Listener | null} */
  let driver = null;

  function notifyAll() {
    for (const listener of listeners) listener.wake();
  }

  /**
   * @param {keyof S} key
   * @param {Scheduler["spawn"]} spawn
   */
  function refresh(key, spawn) {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    lastStartedAt.set(key, now());
    const source = sources[key];
    try {
      spawn(async () => {
        /** @type {Ran} */
        let ran = null;
        try { ran = await exec(source.command, source.args, { timeout: source.timeoutMs }); } catch { /* stays null */ }
        rows[key] = source.rows(ran);
        inFlight.delete(key);
        notifyAll();
      });
    } catch {
      inFlight.delete(key);
    }
  }

  /** @param {Scheduler} scheduler */
  function start(scheduler) {
    for (const [rawKey, source] of Object.entries(sources)) {
      const key = /** @type {keyof S} */ (rawKey);
      const startedAt = lastStartedAt.get(key);
      const elapsed = startedAt === undefined ? Infinity : Math.max(0, now() - startedAt);
      if (elapsed >= source.intervalMs) {
        refresh(key, scheduler.spawn);
        tasks.add(scheduler.every(source.intervalMs, () => refresh(key, scheduler.spawn)));
      } else {
        const waitTask = scheduler.after(source.intervalMs - elapsed, () => {
          tasks.delete(waitTask);
          if (!listeners.size) return;
          refresh(key, scheduler.spawn);
          tasks.add(scheduler.every(source.intervalMs, () => refresh(key, scheduler.spawn)));
        });
        tasks.add(waitTask);
      }
    }
    tasks.add(scheduler.every(minuteMs, () => notifyAll()));
  }

  function stop() {
    for (const task of tasks) task.cancel();
    tasks.clear();
  }

  /** @param {Scheduler} scheduler */
  function attach(scheduler) {
    /** @type {Listener} */
    const listener = {
      scheduler,
      closed: false,
      dirty: false,
      /** @type {((alive: boolean) => void) | null} */
      resolve: null,
      wake() {
        if (this.closed) return;
        if (this.resolve) {
          const resolve = this.resolve;
          this.resolve = null;
          resolve(true);
        } else {
          this.dirty = true;
        }
      },
      waitUpdate() {
        if (this.closed) return Promise.resolve(false);
        if (this.dirty) {
          this.dirty = false;
          return Promise.resolve(true);
        }
        return new Promise((resolve) => {
          this.resolve = resolve;
        });
      },
      close() {
        if (this.closed) return;
        this.closed = true;
        if (this.resolve) {
          const resolve = this.resolve;
          this.resolve = null;
          resolve(false);
        }
      },
    };
    listeners.add(listener);
    if (!driver) {
      driver = listener;
      start(scheduler);
    }
    return {
      waitUpdate: () => listener.waitUpdate(),
      detach() {
        listener.close();
        listeners.delete(listener);
        if (listener !== driver) return;
        stop();
        driver = listeners.values().next().value ?? null;
        if (driver) start(driver.scheduler);
      },
    };
  }

  return { rows, attach };
}
