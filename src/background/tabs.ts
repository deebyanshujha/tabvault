// Operations on live tabs. Tab and window ids may be stale by the time a request
// arrives, so bulk operations filter out what's gone rather than failing wholesale.

import type { RestoreResult, TabColor } from '../shared/types';
import { analyzeClutter, findDuplicates, type ClutterTab } from '../shared/clutter';
import { domainOf, isRestorable, isWebUrl } from '../shared/urls';
import { isProtectedByRules } from '../shared/rules';
import { MINUTE } from '../shared/time';
import { newId } from '../shared/ids';
import { getPrefs } from '../storage/prefs';
import { addToGroup, asColor, groupIntoNew, isOwnPage, tabUrl, toChromeColor, ungroup } from './capture';
import { getMru, pushUndo, takeUndo, type ClosedTabRecord } from './runtime';
import { listRules } from './rules';

export async function existingTabs(ids: number[]): Promise<chrome.tabs.Tab[]> {
  const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)));
  return tabs.filter((t): t is chrome.tabs.Tab => !!t);
}

export const toClutterTab = (t: chrome.tabs.Tab): ClutterTab => ({
  id: t.id ?? -1,
  windowId: t.windowId,
  url: tabUrl(t),
  title: t.title ?? '',
  pinned: !!t.pinned,
  active: !!t.active,
  audible: !!t.audible,
  lastAccessed: (t as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed,
});

export async function normalTabs(windowId?: number): Promise<chrome.tabs.Tab[]> {
  const tabs = await chrome.tabs.query(windowId !== undefined ? { windowId } : { windowType: 'normal' });
  return tabs.filter((t) => !isOwnPage(tabUrl(t)));
}

/** Close tabs but remember enough to put them back. Returns an id for Undo. */
export async function closeTabs(ids: number[]): Promise<{ closed: number; undoId: string | null }> {
  const tabs = await existingTabs(ids);
  if (!tabs.length) return { closed: 0, undoId: null };
  const groupIds = [...new Set(tabs.map((t) => t.groupId).filter((g) => g >= 0))];
  const groups = new Map(
    (await Promise.all(groupIds.map((g) => chrome.tabGroups.get(g).catch(() => null))))
      .filter((g): g is chrome.tabGroups.TabGroup => !!g)
      .map((g) => [g.id, g]),
  );
  const records: ClosedTabRecord[] = tabs
    .filter((t) => isRestorable(tabUrl(t)))
    .map((t) => {
      const group = groups.get(t.groupId);
      return {
        url: tabUrl(t),
        title: t.title ?? '',
        windowId: t.windowId,
        index: t.index,
        pinned: !!t.pinned,
        active: !!t.active,
        groupTitle: group?.title,
        groupColor: group ? asColor(group.color) : undefined,
      };
    });
  const undoId = newId();
  await pushUndo({ id: undoId, at: Date.now(), tabs: records });
  await chrome.tabs.remove(tabs.map((t) => t.id!));
  return { closed: tabs.length, undoId };
}

export async function runUndo(undoId: string): Promise<RestoreResult> {
  const entry = await takeUndo(undoId);
  if (!entry) throw new Error('That can no longer be undone.');
  const result: RestoreResult = { opened: 0, skipped: [], windowIds: [] };
  const fallback = async () => (await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null))?.id;
  const sorted = [...entry.tabs].sort((a, b) => a.index - b.index);
  const groupIds = new Map<string, number>();
  for (const rec of sorted) {
    try {
      // The original window may have closed along with its last tab.
      const alive = await chrome.windows.get(rec.windowId).catch(() => null);
      let windowId = alive?.id ?? (await fallback());
      if (windowId === undefined) {
        const win = await chrome.windows.create({ url: rec.url, focused: true });
        windowId = win?.id;
        result.opened++;
        continue;
      }
      const tab = await chrome.tabs.create({ windowId, url: rec.url, index: alive ? rec.index : undefined, pinned: rec.pinned, active: rec.active });
      result.opened++;
      if (rec.groupTitle !== undefined && tab.id !== undefined) {
        const key = `${windowId}|${rec.groupTitle}`;
        const known = groupIds.get(key);
        const groupId = known !== undefined
          ? await addToGroup([tab.id], known)
          : await groupIntoNew([tab.id], windowId);
        if (known === undefined) {
          groupIds.set(key, groupId);
          await chrome.tabGroups.update(groupId, { title: rec.groupTitle, ...(rec.groupColor ? { color: toChromeColor(rec.groupColor) } : {}) });
        }
      }
    } catch (err) {
      result.skipped.push({ url: rec.url, reason: (err as Error).message });
    }
  }
  return result;
}

export async function focusTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab?.windowId === undefined) return;
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  await chrome.windows.update(tab.windowId, { focused: true, ...(win?.state === 'minimized' ? { state: 'normal' as const } : {}) });
}

export async function jumpToPreviousTab(): Promise<void> {
  const mru = await getMru();
  for (const id of mru.slice(1)) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab) return focusTab(id);
  }
}

async function moveMany(ids: number[], windowId: number, index: number): Promise<void> {
  await chrome.tabs.move(ids as [number, ...number[]], { windowId, index });
}

export async function moveTabs(ids: number[], target: number | 'new', index = -1): Promise<number> {
  const tabs = await existingTabs(ids);
  if (!tabs.length) return -1;
  if (target === 'new') {
    const win = await chrome.windows.create({ tabId: tabs[0]!.id, focused: true });
    if (win?.id === undefined) throw new Error('Could not open a new window.');
    if (tabs.length > 1) await moveMany(tabs.slice(1).map((t) => t.id!), win.id, -1);
    return win.id;
  }
  await moveMany(tabs.map((t) => t.id!), target, index);
  return target;
}

export async function setPinned(ids: number[], pinned: boolean): Promise<void> {
  await Promise.all((await existingTabs(ids)).map((t) => chrome.tabs.update(t.id!, { pinned })));
}

export async function setMuted(ids: number[], muted: boolean): Promise<void> {
  await Promise.all((await existingTabs(ids)).map((t) => chrome.tabs.update(t.id!, { muted })));
}

/** chrome.tabs.discard refuses some tabs (active, chrome://). Report how many took. */
export async function sleepTabs(ids: number[]): Promise<number> {
  const tabs = (await existingTabs(ids)).filter((t) => !t.active && !t.discarded && isWebUrl(tabUrl(t)));
  const results = await Promise.all(tabs.map((t) => chrome.tabs.discard(t.id!).then(() => 1, () => 0)));
  return results.reduce<number>((a, b) => a + b, 0);
}

export async function reloadTabs(ids: number[]): Promise<void> {
  await Promise.all((await existingTabs(ids)).map((t) => chrome.tabs.reload(t.id!).catch(() => undefined)));
}

export async function groupTabs(ids: number[], options: { title?: string; color?: string; groupId?: number }): Promise<number> {
  const tabs = (await existingTabs(ids)).filter((t) => !t.pinned);
  if (!tabs.length) throw new Error('Pinned tabs can’t be grouped.');
  const windowId = tabs[0]!.windowId;
  const sameWindow = tabs.filter((t) => t.windowId === windowId);
  const tabIds = sameWindow.map((t) => t.id!);
  const groupId = options.groupId !== undefined ? await addToGroup(tabIds, options.groupId) : await groupIntoNew(tabIds, windowId);
  if (options.title !== undefined || options.color) {
    await chrome.tabGroups.update(groupId, {
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.color ? { color: toChromeColor(asColor(options.color)) } : {}),
    });
  }
  return groupId;
}

export async function ungroupTabs(ids: number[]): Promise<void> {
  const tabs = await existingTabs(ids);
  const grouped = tabs.filter((t) => t.groupId >= 0).map((t) => t.id!);
  if (grouped.length) await ungroup(grouped);
}

export async function closeDuplicates(windowId?: number) {
  const tabs = (await normalTabs(windowId)).map(toClutterTab);
  const extras = findDuplicates(tabs).flatMap((s) => s.extras.map((t) => t.id));
  return closeTabs(extras);
}

export async function closeStale() {
  const prefs = await getPrefs();
  const rules = await listRules();
  const report = analyzeClutter((await normalTabs()).map(toClutterTab), {
    staleDays: prefs.staleDays,
    isProtected: (t) => isProtectedByRules(rules, t),
  });
  return closeTabs(report.stale.map((t) => t.id));
}

export async function sleepInactive(olderThanMinutes = 0): Promise<number> {
  const rules = await listRules();
  const cut = Date.now() - olderThanMinutes * MINUTE;
  const tabs = (await normalTabs()).filter((t) => {
    const last = (t as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed ?? 0;
    return (
      !t.active && !t.pinned && !t.audible && !t.discarded && isWebUrl(tabUrl(t)) &&
      (olderThanMinutes === 0 || (last > 0 && last < cut)) &&
      !isProtectedByRules(rules, { url: tabUrl(t), title: t.title })
    );
  });
  return sleepTabs(tabs.map((t) => t.id!));
}

const GROUP_PALETTE: TabColor[] = ['blue', 'orange', 'green', 'pink', 'cyan', 'purple', 'yellow', 'red'];

/** Stable colour per domain: the same site gets the same group colour every time. */
function colorFor(domain: string): TabColor {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) hash = (hash * 31 + domain.charCodeAt(i)) >>> 0;
  return GROUP_PALETTE[hash % GROUP_PALETTE.length]!;
}

/** Group a window's loose tabs by site. Existing groups are the user's: leave them. */
export async function organizeByDomain(windowId?: number): Promise<{ groups: number; tabs: number }> {
  const targets = windowId !== undefined
    ? [windowId]
    : (await chrome.windows.getAll({ windowTypes: ['normal'] })).map((w) => w.id!).filter((x) => x !== undefined);
  let groups = 0;
  let count = 0;
  for (const win of targets) {
    const tabs = (await chrome.tabs.query({ windowId: win })).filter((t) => !t.pinned && t.groupId < 0 && isWebUrl(tabUrl(t)));
    const byDomain = new Map<string, number[]>();
    for (const t of tabs) {
      const d = domainOf(tabUrl(t));
      byDomain.set(d, [...(byDomain.get(d) ?? []), t.id!]);
    }
    for (const [domain, ids] of byDomain) {
      if (ids.length < 2) continue;
      const groupId = await groupIntoNew(ids, win);
      await chrome.tabGroups.update(groupId, { title: domain, color: toChromeColor(colorFor(domain)), collapsed: false });
      groups++;
      count += ids.length;
    }
  }
  return { groups, tabs: count };
}

export type SortKey = 'domain' | 'title' | 'recent';

/** Sort a window's unpinned, ungrouped tabs. Groups stay as blocks where they are. */
export async function sortWindow(windowId: number, by: SortKey): Promise<void> {
  const tabs = await chrome.tabs.query({ windowId });
  const loose = tabs.filter((t) => !t.pinned && t.groupId < 0);
  const key = (t: chrome.tabs.Tab): string | number =>
    by === 'domain' ? `${domainOf(tabUrl(t))} ${t.title ?? ''}` :
    by === 'title' ? (t.title ?? '').toLowerCase() :
    -((t as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed ?? 0);
  const sorted = [...loose].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return typeof ka === 'number' ? ka - (kb as number) : ka.localeCompare(kb as string);
  });
  // Sending each to the end in sorted order can't drop one inside a group.
  for (const tab of sorted) await chrome.tabs.move(tab.id!, { index: -1 }).catch(() => undefined);
}

/** Pull every window's tabs into the focused one. */
export async function mergeWindows(): Promise<number> {
  const target = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id!;
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  let moved = 0;
  for (const win of windows) {
    if (win.id === target) continue;
    const ids = (win.tabs ?? []).filter((t) => !t.pinned).map((t) => t.id!);
    if (!ids.length) continue;
    await moveMany(ids, target, -1).catch(() => undefined);
    moved += ids.length;
  }
  return moved;
}

export interface ClosedEntry {
  kind: 'tab' | 'window';
  sessionId: string;
  title: string;
  url: string;
  at: number;
  tabCount: number;
}

export async function recentlyClosed(limit = 25): Promise<ClosedEntry[]> {
  const items = await chrome.sessions.getRecentlyClosed({ maxResults: Math.min(limit, 25) }).catch(() => [] as chrome.sessions.Session[]);
  const out: ClosedEntry[] = [];
  for (const s of items) {
    if (s.tab) {
      if (isOwnPage(s.tab.url ?? '')) continue;
      out.push({ kind: 'tab', sessionId: s.tab.sessionId ?? '', title: s.tab.title ?? '', url: s.tab.url ?? '', at: s.lastModified * 1000, tabCount: 1 });
    } else if (s.window) {
      const first = s.window.tabs?.[0];
      out.push({ kind: 'window', sessionId: s.window.sessionId ?? '', title: first?.title ?? 'Window', url: first?.url ?? '', at: s.lastModified * 1000, tabCount: s.window.tabs?.length ?? 0 });
    }
  }
  return out;
}

export async function reopenClosed(sessionId: string): Promise<void> {
  await chrome.sessions.restore(sessionId);
}

export async function openDashboard(hash = ''): Promise<void> {
  const url = chrome.runtime.getURL('dashboard.html');
  const [existing] = await chrome.tabs.query({ url: `${url}*` });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true, ...(hash ? { url: `${url}#${hash}` } : {}) });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: hash ? `${url}#${hash}` : url });
}
