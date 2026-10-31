// Local-only usage counters. Domain level on purpose: no URLs, no titles.

import type { DayActivity } from '../shared/types';
import { activityParser } from '../shared/schemas';
import { domainOf, isWebUrl } from '../shared/urls';
import { dayKey } from '../shared/time';
import { addToHours, emptyDay } from '../shared/insights';
import { mutate, readAll, transact, request } from '../storage/db';
import { getPrefs } from '../storage/prefs';
import { sessionGet, sessionSet } from './runtime';
import { tabUrl } from './capture';

const STORE = 'activity';
const FOCUS_KEY = 'focus';
/** Guards against a missed event counting hours of absence as focus. */
const MAX_SPAN_SECONDS = 30 * 60;

interface FocusState {
  domain: string;
  since: number;
  /** Seconds of this unbroken stay already credited at earlier checkpoints. */
  run?: number;
}

function bump(fn: (d: DayActivity) => DayActivity) {
  const day = dayKey(Date.now());
  return mutate<DayActivity>(STORE, day, (d) => fn(d ?? emptyDay(day)));
}

export async function countTabOpened(): Promise<void> {
  if (!(await getPrefs()).activity) return;
  await bump((d) => ({ ...d, opened: d.opened + 1 }));
}

export async function countTabClosed(): Promise<void> {
  if (!(await getPrefs()).activity) return;
  await bump((d) => ({ ...d, closed: d.closed + 1 }));
}

export async function recordPeak(tabCount: number): Promise<void> {
  if (!(await getPrefs()).activity) return;
  const day = dayKey(Date.now());
  await mutate<DayActivity>(STORE, day, (d) => {
    const current = d ?? emptyDay(day);
    return tabCount > current.peakTabs ? { ...current, peakTabs: tabCount } : undefined;
  });
}

async function flushFocus(next: FocusState | null): Promise<void> {
  const current = await sessionGet<FocusState | null>(FOCUS_KEY, null);
  if (!current) {
    await sessionSet(FOCUS_KEY, next);
    return;
  }
  const now = Date.now();
  const seconds = Math.min((now - current.since) / 1000, MAX_SPAN_SECONDS);
  const run = (current.run ?? 0) + seconds;
  const sameSite = next?.domain === current.domain;
  await sessionSet(FOCUS_KEY, next && sameSite ? { ...next, run } : next);
  if (seconds < 1) return;
  await bump((d) => ({
    ...d,
    focusSeconds: { ...d.focusSeconds, [current.domain]: (d.focusSeconds[current.domain] ?? 0) + seconds },
    hours: addToHours(d.hours, now, seconds),
    switches: d.switches + (next && !sameSite ? 1 : 0),
    longest: run > (d.longest?.seconds ?? 0) ? { domain: current.domain, seconds: run } : d.longest,
  }));
}

/**
 * Re-derive what's being looked at. Called on tab, window and idle changes.
 * `checkpoint` also banks the time so far, so a long stay on one site is counted in full
 * rather than cut off at the span cap when it finally ends.
 */
export async function updateFocus(checkpoint = false): Promise<void> {
  const prefs = await getPrefs();
  if (!prefs.activity) return flushFocus(null);
  const idle = await chrome.idle.queryState(120);
  const win = idle === 'active' ? await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null) : null;
  let next: FocusState | null = null;
  if (win?.focused) {
    const [tab] = await chrome.tabs.query({ windowId: win.id, active: true });
    const url = tab ? tabUrl(tab) : '';
    if (isWebUrl(url)) next = { domain: domainOf(url), since: Date.now() };
  }
  const current = await sessionGet<FocusState | null>(FOCUS_KEY, null);
  if (!checkpoint && current && next && current.domain === next.domain) return;
  await flushFocus(next);
}

export const readActivity = () => readAll<DayActivity>(STORE, activityParser);

export async function clearActivity(): Promise<void> {
  await sessionSet(FOCUS_KEY, null);
  await transact(STORE, 'readwrite', async (tx) => {
    await request(tx.objectStore(STORE).clear());
  });
}
