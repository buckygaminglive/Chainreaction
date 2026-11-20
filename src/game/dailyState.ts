/** Device-local record of Daily Blast play: today's tries, the streak, and
 *  the totals the result card shows. Validated on read like every other
 *  stored record — a hand-edited or older value must never break the menu. */
import { DAILY_TRIES } from './daily.ts';

const KEY = 'fissile.daily.v1';

export interface DayRecord {
  /** Chain depth reached on each try, in order. */
  tries: number[];
  best: number;
  done: boolean;
}

export interface DailyState {
  days: Record<string, DayRecord>;
  streak: number;
  /** The last day number completed, for streak continuity. */
  lastDone: number;
  played: number;
  perfect: number;
}

const EMPTY: DailyState = { days: {}, streak: 0, lastDone: 0, played: 0, perfect: 0 };

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
}

function read(): DailyState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(EMPTY);
    const p = JSON.parse(raw) as Partial<DailyState>;
    const days: Record<string, DayRecord> = {};
    if (p.days && typeof p.days === 'object') {
      // Only the most recent fortnight is worth keeping.
      const keys = Object.keys(p.days).sort((a, b) => Number(b) - Number(a)).slice(0, 14);
      for (const k of keys) {
        const d = (p.days as Record<string, Partial<DayRecord>>)[k];
        if (!d) continue;
        const tries = Array.isArray(d.tries) ? d.tries.slice(0, DAILY_TRIES).map(n) : [];
        days[k] = { tries, best: n(d.best), done: d.done === true };
      }
    }
    return { days, streak: n(p.streak), lastDone: n(p.lastDone), played: n(p.played), perfect: n(p.perfect) };
  } catch {
    return structuredClone(EMPTY);
  }
}

function write(s: DailyState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — the puzzle still plays, it just forgets */
  }
}

export const dailyState = {
  get(): DailyState {
    return read();
  },

  day(day: number): DayRecord | null {
    return read().days[String(day)] ?? null;
  },

  /** The streak as it stands today: one that skipped yesterday is gone. */
  liveStreak(today: number): number {
    const s = read();
    return s.lastDone >= today - 1 ? s.streak : 0;
  },

  /** Records one try. Returns the updated day. */
  recordTry(day: number, best: number, chain: number): DayRecord {
    const s = read();
    const key = String(day);
    const rec = s.days[key] ?? { tries: [], best, done: false };
    if (rec.done || rec.tries.length >= DAILY_TRIES) return rec;
    rec.best = best;
    rec.tries.push(chain);
    const solved = chain >= best;
    if (solved || rec.tries.length >= DAILY_TRIES) {
      rec.done = true;
      s.played += 1;
      if (Math.max(...rec.tries) >= best) s.perfect += 1;
      if (s.lastDone !== day) {
        s.streak = s.lastDone === day - 1 ? s.streak + 1 : 1;
        s.lastDone = day;
      }
    }
    s.days[key] = rec;
    write(s);
    return rec;
  },
};
