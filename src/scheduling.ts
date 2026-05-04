/**
 * Scheduled monitoring — `cron` field in a plan + a scheduler tick.
 *
 *   ---
 *   name: Checkout monitor
 *   target: https://shop.example.com
 *   cron: every 15m         ← runs every 15 minutes for as long as the
 *                              `serve` daemon (or `monitor` command) is up
 *   ---
 *   ## Steps
 *   1. ...
 *
 * Supported cron expressions (intentionally tiny — full cron is overkill):
 *
 *   "every 30s" / "every 5m" / "every 2h" / "every 1d"
 *   "0 9 * * *"  (5-field cron — minute hour day-of-month month day-of-week)
 *
 * The scheduler is wall-clock-based: it computes "next fire" from the
 * cron expression and the current time, sets a setTimeout, and fires.
 * Drift is corrected each tick.
 */

export interface Schedule {
  /** Original expression, for the report. */
  expression: string;
  /** ms until next fire from `from`. */
  nextFireMs(from: Date): number;
}

const EVERY_RE = /^every\s+(\d+)\s*(s|m|h|d)$/i;

export function parseSchedule(expr: string): Schedule | null {
  const trimmed = expr.trim();

  // "every Nx" form
  const m = trimmed.match(EVERY_RE);
  if (m && m[1] && m[2]) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const ms = n * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
    return {
      expression: trimmed,
      nextFireMs: () => ms, // simple recurrence — fire every `ms` from now
    };
  }

  // 5-field cron — minute hour dom month dow
  const fields = trimmed.split(/\s+/);
  if (fields.length === 5) {
    return {
      expression: trimmed,
      nextFireMs: (from) => msUntilNextCron(fields as [string, string, string, string, string], from),
    };
  }

  return null;
}

function matchesField(value: number, field: string, min: number, max: number): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    return step > 0 && (value - min) % step === 0;
  }
  if (field.includes(",")) return field.split(",").some((p) => matchesField(value, p, min, max));
  if (field.includes("-")) {
    const [a, b] = field.split("-").map(Number);
    if (a !== undefined && b !== undefined) return value >= a && value <= b;
  }
  const n = parseInt(field, 10);
  return !Number.isNaN(n) && n === value;
}

function msUntilNextCron(fields: [string, string, string, string, string], from: Date): number {
  const [minute, hour, dom, month, dow] = fields;
  // Cap search to ~366 days. Tick by minute.
  for (let i = 1; i <= 60 * 24 * 366; i++) {
    const d = new Date(from.getTime() + i * 60_000);
    d.setSeconds(0, 0);
    if (
      matchesField(d.getMinutes(), minute!, 0, 59) &&
      matchesField(d.getHours(), hour!, 0, 23) &&
      matchesField(d.getDate(), dom!, 1, 31) &&
      matchesField(d.getMonth() + 1, month!, 1, 12) &&
      matchesField(d.getDay(), dow!, 0, 6)
    ) {
      return d.getTime() - from.getTime();
    }
  }
  return Number.POSITIVE_INFINITY; // never matches
}

/**
 * In-process scheduler. Caller registers a (planMd, schedule, fire) triple;
 * the scheduler arms a setTimeout for each. Cancel by invoking the returned
 * function.
 */
export interface Scheduler {
  register(id: string, schedule: Schedule, fire: () => void | Promise<void>): void;
  unregister(id: string): void;
  list(): Array<{ id: string; expression: string; next_fire_at: string }>;
  shutdown(): void;
}

export function createScheduler(): Scheduler {
  const timers = new Map<string, NodeJS.Timeout>();
  const records = new Map<string, { expression: string; next_fire_at: number; fire: () => void | Promise<void>; schedule: Schedule }>();

  function arm(id: string) {
    const r = records.get(id);
    if (!r) return;
    const wait = r.schedule.nextFireMs(new Date());
    if (!Number.isFinite(wait)) return;
    r.next_fire_at = Date.now() + wait;
    const handle = setTimeout(async () => {
      try { await r.fire(); } catch (e) { console.error(`[scheduler] ${id}:`, (e as Error).message); }
      arm(id); // re-arm for the next interval
    }, wait);
    timers.set(id, handle);
  }

  return {
    register(id, schedule, fire) {
      // If something with this id already exists, replace it.
      this.unregister(id);
      records.set(id, { expression: schedule.expression, next_fire_at: 0, fire, schedule });
      arm(id);
    },
    unregister(id) {
      const t = timers.get(id);
      if (t) clearTimeout(t);
      timers.delete(id);
      records.delete(id);
    },
    list() {
      return [...records.entries()].map(([id, r]) => ({
        id,
        expression: r.expression,
        next_fire_at: new Date(r.next_fire_at).toISOString(),
      }));
    },
    shutdown() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      records.clear();
    },
  };
}
