import { domainOf, isNewTabUrl, isWebUrl, urlKey } from './urls';
import { DAY } from './time';

export interface ClutterTab {
  id: number;
  windowId: number;
  url: string;
  title: string;
  pinned: boolean;
  active: boolean;
  audible: boolean;
  lastAccessed?: number;
}

export interface DuplicateSet {
  key: string;
  keep: ClutterTab;
  extras: ClutterTab[];
}

export interface ClutterReport {
  total: number;
  duplicates: DuplicateSet[];
  duplicateCount: number;
  stale: ClutterTab[];
  blank: ClutterTab[];
  hoards: { domain: string; tabs: ClutterTab[] }[];
  singleTabWindows: number[];
}

const rank = (t: ClutterTab) => (t.active ? 4 : 0) + (t.pinned ? 2 : 0) + (t.audible ? 1 : 0);

/** Which copy to keep: the one you're using, then pinned, then most recently used. */
function pickKeeper(tabs: ClutterTab[]): ClutterTab {
  return [...tabs].sort((a, b) => rank(b) - rank(a) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0]!;
}

export function findDuplicates(tabs: ClutterTab[]): DuplicateSet[] {
  const byKey = new Map<string, ClutterTab[]>();
  for (const tab of tabs) {
    if (!tab.url || isNewTabUrl(tab.url)) continue;
    const key = urlKey(tab.url);
    const list = byKey.get(key);
    if (list) list.push(tab);
    else byKey.set(key, [tab]);
  }
  const out: DuplicateSet[] = [];
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    const keep = pickKeeper(list);
    // A pinned or currently active duplicate is there on purpose; never close it.
    const extras = list.filter((t) => t !== keep && !t.pinned && !t.active);
    if (extras.length) out.push({ key, keep, extras });
  }
  return out;
}

export function analyzeClutter(
  tabs: ClutterTab[],
  { staleDays, isProtected, now = Date.now() }: { staleDays: number; isProtected?: (t: ClutterTab) => boolean; now?: number },
): ClutterReport {
  const duplicates = findDuplicates(tabs);
  const staleCut = now - staleDays * DAY;
  const stale = tabs.filter(
    (t) => !t.pinned && !t.active && !t.audible && isWebUrl(t.url) && !!t.lastAccessed && t.lastAccessed < staleCut && !isProtected?.(t),
  );
  const blank = tabs.filter((t) => !t.active && !t.pinned && isNewTabUrl(t.url));
  const byDomain = new Map<string, ClutterTab[]>();
  for (const t of tabs) {
    if (!isWebUrl(t.url)) continue;
    const d = domainOf(t.url);
    const list = byDomain.get(d);
    if (list) list.push(t);
    else byDomain.set(d, [t]);
  }
  const hoards = [...byDomain.entries()]
    .filter(([, list]) => list.length >= 5)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([domain, list]) => ({ domain, tabs: list }));
  const perWindow = new Map<number, number>();
  for (const t of tabs) perWindow.set(t.windowId, (perWindow.get(t.windowId) ?? 0) + 1);
  const singleTabWindows = perWindow.size > 1 ? [...perWindow.entries()].filter(([, n]) => n === 1).map(([id]) => id) : [];
  return {
    total: tabs.length,
    duplicates,
    duplicateCount: duplicates.reduce((n, s) => n + s.extras.length, 0),
    stale,
    blank,
    hoards,
    singleTabWindows,
  };
}
