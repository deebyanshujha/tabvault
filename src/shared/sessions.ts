import { domainOf, urlKey } from './urls';
import { DAY, HOUR } from './time';
import { fnv1a } from './ids';
import type { SavedWindow, Session, SessionSummary } from './types';

/** Order-independent so a tab drag doesn't create a new snapshot. */
export function fingerprintOf(windows: SavedWindow[]): string {
  const urls = windows.flatMap((w) => w.tabs.map((t) => urlKey(t.url))).sort();
  return fnv1a(urls.join('\n'));
}

export function topDomains(urls: string[], limit = 3): string[] {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const d = domainOf(url);
    if (d && d !== 'browser' && d !== 'extension') counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([d]) => d);
}

const partOfDay = (h: number) => (h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'night');

/** "github.com & docs.rs +12 · Tuesday evening" */
export function autoSessionName(urls: string[], now = Date.now()): string {
  const d = new Date(now);
  const when = `${d.toLocaleDateString(undefined, { weekday: 'long' })} ${partOfDay(d.getHours())}`;
  const domains = topDomains(urls, 2);
  if (!domains.length) return `Session · ${when}`;
  const others = new Set(urls.map(domainOf)).size - domains.length;
  return `${domains.join(' & ')}${others > 0 ? ` +${others}` : ''} · ${when}`;
}

export function summarize(session: Session): SessionSummary {
  const { windows, ...rest } = session;
  return {
    ...rest,
    windowCount: windows.length,
    topDomains: topDomains(windows.flatMap((w) => w.tabs.map((t) => t.url))),
  };
}

export interface Stamped {
  id: string;
  createdAt: number;
  keep?: boolean;
}

/**
 * Time Machine retention: everything from the last hour, one per hour for a day,
 * one per day for two weeks. Returns ids to delete. Newest in a bucket survives.
 */
export function snapshotsToPrune(snapshots: Stamped[], now = Date.now()): string[] {
  const sorted = [...snapshots].sort((a, b) => b.createdAt - a.createdAt);
  const seen = new Set<string>();
  const prune: string[] = [];
  for (const snap of sorted) {
    if (snap.keep) continue;
    const age = now - snap.createdAt;
    let bucket: string | null;
    if (age <= HOUR) bucket = snap.id;
    else if (age <= DAY) bucket = `h${Math.floor(snap.createdAt / HOUR)}`;
    else if (age <= 14 * DAY) bucket = `d${Math.floor(snap.createdAt / DAY)}`;
    else bucket = null;
    if (bucket === null || seen.has(bucket)) prune.push(snap.id);
    else seen.add(bucket);
  }
  return prune;
}

/**
 * Which previously open tabs did not come back after a restart? Multiset-aware:
 * two copies before and one after means one is missing.
 */
export function missingAfterRestart<T extends { url: string }>(previous: T[], current: { url: string }[]): T[] {
  const open = new Map<string, number>();
  for (const t of current) {
    const k = urlKey(t.url);
    open.set(k, (open.get(k) ?? 0) + 1);
  }
  const missing: T[] = [];
  for (const t of previous) {
    const k = urlKey(t.url);
    const left = open.get(k) ?? 0;
    if (left > 0) open.set(k, left - 1);
    else missing.push(t);
  }
  return missing;
}

/** Share of `saved` URLs present in `live`. Used to re-bind windows after a restart. */
export function overlapRatio(saved: string[], live: string[]): number {
  if (!saved.length) return 0;
  const liveKeys = new Set(live.map(urlKey));
  let hits = 0;
  for (const url of saved) if (liveKeys.has(urlKey(url))) hits++;
  return hits / saved.length;
}
