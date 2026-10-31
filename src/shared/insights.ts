// Turns the daily activity counters into the numbers the Insights page shows.
// Pure, so it can be tested without a browser. Everything stays at site level.

import type { DayActivity } from './types';
import { DAY, dayKey } from './time';

/** The chart gets five named sites at most; the rest fold into "Other". */
export const MAX_SLICES = 5;

export interface Slice {
  label: string;
  domain?: string;
  seconds: number;
  share: number;
  /** Colour slot, 0-4. Undefined for "Other". */
  slot?: number;
  /** How many sites "Other" stands for. */
  count?: number;
}

export interface InsightSummary {
  seconds: number;
  opened: number;
  closed: number;
  peak: number;
  sites: { domain: string; seconds: number; share: number }[];
  slices: Slice[];
  /** Percent change from the period before. Null when that period has no data. */
  change: number | null;
  previousSeconds: number;
  /** Sites first seen in this period. Null when there's no earlier history to compare with. */
  newSites: string[] | null;
  topThreeShare: number;
  busiestDay: { day: string; seconds: number } | null;
  longest: { domain: string; seconds: number } | null;
  /** Average seconds between site changes. Null until there are enough changes to mean anything. */
  switchEvery: number | null;
  switches: number;
  /** Consecutive days with focus time, ending today or yesterday. */
  streak: number;
  /** Seconds by weekday (Monday first) and hour. */
  grid: number[][];
  gridMax: number;
  peakHour: { hour: number; seconds: number } | null;
}

export const emptyDay = (day: string): DayActivity => ({ day, focusSeconds: {}, hours: {}, switches: 0, opened: 0, closed: 0, peakTabs: 0 });

/** Credit a span ending at `end` to the clock hours it covered. */
export function addToHours(hours: Record<string, number>, end: number, seconds: number): Record<string, number> {
  const out = { ...hours };
  let remaining = seconds;
  let t = end;
  while (remaining > 0) {
    const d = new Date(t);
    const intoHour = d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
    // Exactly on the hour: what came before belongs to the previous hour.
    if (!intoHour) {
      t -= 1;
      continue;
    }
    const take = Math.min(remaining, intoHour);
    const key = String(d.getHours());
    out[key] = (out[key] ?? 0) + take;
    remaining -= take;
    t -= take * 1000;
  }
  return out;
}

const sum = (values: Iterable<number>) => {
  let n = 0;
  for (const v of values) n += v;
  return n;
};

function focusBySite(days: DayActivity[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const d of days) for (const [domain, s] of Object.entries(d.focusSeconds)) totals.set(domain, (totals.get(domain) ?? 0) + s);
  return totals;
}

/** Monday first, so the working week reads as one block. */
const weekdayIndex = (day: string) => (new Date(`${day}T12:00:00`).getDay() + 6) % 7;

export function summarize(all: DayActivity[], span: number, now = Date.now()): InsightSummary {
  const byDay = new Map(all.map((d) => [d.day, d]));
  const dayAt = (i: number) => dayKey(now - i * DAY);
  const series: DayActivity[] = [];
  for (let i = span - 1; i >= 0; i--) series.push(byDay.get(dayAt(i)) ?? emptyDay(dayAt(i)));
  const inRange = new Set(series.map((d) => d.day));

  const focus = focusBySite(series);
  const seconds = sum(focus.values());
  const ranked = [...focus.entries()].sort((a, b) => b[1] - a[1]);
  const sites = ranked.map(([domain, s]) => ({ domain, seconds: s, share: seconds ? s / seconds : 0 }));

  // A site's colour comes from its all-time rank, so changing the range doesn't repaint it.
  const allTime = [...focusBySite(all).entries()].sort((a, b) => b[1] - a[1]).map(([domain]) => domain);
  const named = sites.slice(0, MAX_SLICES);
  const taken = new Set(named.map((s) => allTime.indexOf(s.domain)).filter((r) => r >= 0 && r < MAX_SLICES));
  const free = [0, 1, 2, 3, 4].filter((n) => !taken.has(n));
  const slices: Slice[] = named.map((s) => {
    const rank = allTime.indexOf(s.domain);
    return { label: s.domain, domain: s.domain, seconds: s.seconds, share: s.share, slot: rank >= 0 && rank < MAX_SLICES ? rank : free.shift()! };
  });
  const rest = sites.slice(MAX_SLICES);
  if (rest.length) {
    const restSeconds = sum(rest.map((s) => s.seconds));
    slices.push({ label: 'Other', seconds: restSeconds, share: seconds ? restSeconds / seconds : 0, count: rest.length });
  }

  let previousSeconds = 0;
  for (let i = span; i < span * 2; i++) {
    const d = byDay.get(dayAt(i));
    if (d) previousSeconds += sum(Object.values(d.focusSeconds));
  }

  const earlier = all.filter((d) => !inRange.has(d.day) && d.day < series[0]!.day);
  const seenBefore = focusBySite(earlier);
  const newSites = seenBefore.size ? ranked.map(([domain]) => domain).filter((domain) => !seenBefore.has(domain)) : null;

  let busiestDay: InsightSummary['busiestDay'] = null;
  let longest: InsightSummary['longest'] = null;
  let switches = 0;
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const hourTotals = new Array<number>(24).fill(0);
  for (const d of series) {
    const daySeconds = sum(Object.values(d.focusSeconds));
    if (daySeconds && (!busiestDay || daySeconds > busiestDay.seconds)) busiestDay = { day: d.day, seconds: daySeconds };
    if (d.longest && (!longest || d.longest.seconds > longest.seconds)) longest = d.longest;
    switches += d.switches;
    const row = grid[weekdayIndex(d.day)]!;
    for (const [hour, s] of Object.entries(d.hours)) {
      const h = Number(hour);
      if (h >= 0 && h < 24) {
        row[h] = row[h]! + s;
        hourTotals[h] = hourTotals[h]! + s;
      }
    }
  }

  let peakHour: InsightSummary['peakHour'] = null;
  hourTotals.forEach((s, hour) => {
    if (s > 0 && (!peakHour || s > peakHour.seconds)) peakHour = { hour, seconds: s };
  });

  const hasFocus = (i: number) => sum(Object.values(byDay.get(dayAt(i))?.focusSeconds ?? {})) > 0;
  // Today may simply not have started yet, so it doesn't break a streak.
  let streak = 0;
  for (let i = hasFocus(0) ? 0 : 1; hasFocus(i); i++) streak++;

  return {
    seconds,
    opened: sum(series.map((d) => d.opened)),
    closed: sum(series.map((d) => d.closed)),
    peak: Math.max(0, ...series.map((d) => d.peakTabs)),
    sites,
    slices,
    change: previousSeconds ? Math.round(((seconds - previousSeconds) / previousSeconds) * 100) : null,
    previousSeconds,
    newSites,
    topThreeShare: seconds ? sum(sites.slice(0, 3).map((s) => s.seconds)) / seconds : 0,
    busiestDay,
    longest,
    switchEvery: switches >= 3 ? seconds / switches : null,
    switches,
    streak,
    grid,
    gridMax: Math.max(0, ...grid.flat()),
    peakHour,
  };
}

export function formatHour(hour: number): string {
  return new Date(2020, 0, 1, hour).toLocaleTimeString(undefined, { hour: 'numeric' });
}
