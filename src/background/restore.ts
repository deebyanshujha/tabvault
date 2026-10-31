// Opening saved tabs. The dangerous part of the product: URLs may be stale, windows
// may be gone, and hundreds of simultaneous loads would hurt. Every tab is attempted
// separately, so one bad URL costs one tab rather than the whole restore.

import type { RestoreResult, SavedGroup, SavedTab } from '../shared/types';
import { isRestorable } from '../shared/urls';
import { getPrefs } from '../storage/prefs';
import { groupIntoNew, toChromeColor } from './capture';

const BATCH = 6;
const COMMIT_WAIT_MS = 1500;
const SLEEP_THRESHOLD = 5;

let restoring = 0;
/** Lets the duplicate-focus logic stay out of the way during a restore. */
export const isRestoring = () => restoring > 0;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tab can't be discarded before its URL commits or it would lose the URL. Poll briefly. */
async function sleepCommitted(tabIds: number[]): Promise<void> {
  const deadline = Date.now() + COMMIT_WAIT_MS;
  const pending = new Set(tabIds);
  while (pending.size && Date.now() < deadline) {
    await delay(120);
    for (const id of [...pending]) {
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (!tab) {
        pending.delete(id);
      } else if (tab.url && !tab.pendingUrl) {
        pending.delete(id);
        if (!tab.active) await chrome.tabs.discard(id).catch(() => undefined);
      }
    }
  }
}

export interface OpenOptions {
  /** Index of the tab to make active; omit to leave focus alone. */
  activeIndex?: number;
  lazy?: boolean;
  /** Already-open tab to count as the first entry (windows.create opens one). */
  firstTabId?: number;
}

export async function openTabsInWindow(
  windowId: number,
  tabs: SavedTab[],
  groups: SavedGroup[],
  options: OpenOptions = {},
): Promise<RestoreResult> {
  restoring++;
  const skipped: RestoreResult['skipped'] = [];
  const createdByGroup = new Map<string, number[]>();
  let opened = 0;
  try {
    const prefs = await getPrefs();
    const lazy = options.lazy ?? (prefs.restoreAsleep && tabs.length > SLEEP_THRESHOLD);
    let batch: number[] = [];
    for (let i = 0; i < tabs.length; i++) {
      const saved = tabs[i]!;
      if (!isRestorable(saved.url)) {
        skipped.push({ url: saved.url, reason: 'Unsupported address' });
        continue;
      }
      try {
        let tabId = i === 0 ? options.firstTabId : undefined;
        if (tabId === undefined) {
          const tab = await chrome.tabs.create({
            windowId,
            url: saved.url,
            pinned: saved.pinned,
            active: options.activeIndex === i,
          });
          tabId = tab.id;
        } else if (saved.pinned) {
          await chrome.tabs.update(tabId, { pinned: true });
        }
        if (tabId === undefined) continue;
        opened++;
        if (saved.groupKey && !saved.pinned) {
          const list = createdByGroup.get(saved.groupKey);
          if (list) list.push(tabId);
          else createdByGroup.set(saved.groupKey, [tabId]);
        }
        if (lazy && !saved.pinned && options.activeIndex !== i) batch.push(tabId);
        if (batch.length >= BATCH) {
          await sleepCommitted(batch);
          batch = [];
        }
      } catch (err) {
        skipped.push({ url: saved.url, reason: (err as Error).message || 'Could not open' });
      }
    }
    if (batch.length) await sleepCommitted(batch);
    await regroup(windowId, createdByGroup, groups);
    return { opened, skipped, windowIds: opened ? [windowId] : [] };
  } finally {
    restoring--;
  }
}

async function regroup(windowId: number, byGroup: Map<string, number[]>, groups: SavedGroup[]): Promise<void> {
  for (const [key, tabIds] of byGroup) {
    const meta = groups.find((g) => g.key === key);
    try {
      const groupId = await groupIntoNew(tabIds, windowId);
      if (meta) {
        await chrome.tabGroups.update(groupId, {
          title: meta.title,
          color: toChromeColor(meta.color),
          collapsed: meta.collapsed,
        });
      }
    } catch {
      // Grouping is cosmetic: never fail a restore over it.
    }
  }
}

/** Restore into a brand new window. Falls forward past leading bad URLs. */
export async function openInNewWindow(
  tabs: SavedTab[],
  groups: SavedGroup[],
  { focused = true, lazy }: { focused?: boolean; lazy?: boolean } = {},
): Promise<RestoreResult> {
  const skipped: RestoreResult['skipped'] = [];
  const usable = tabs.filter((t) => {
    const ok = isRestorable(t.url);
    if (!ok) skipped.push({ url: t.url, reason: 'Unsupported address' });
    return ok;
  });
  if (!usable.length) {
    const win = await chrome.windows.create({ focused });
    return { opened: 0, skipped, windowIds: win?.id !== undefined ? [win.id] : [] };
  }
  const win = await chrome.windows.create({ url: usable[0]!.url, focused });
  if (win?.id === undefined) throw new Error('Could not open a new window');
  const result = await openTabsInWindow(win.id, usable, groups, {
    firstTabId: win.tabs?.[0]?.id,
    activeIndex: 0,
    lazy,
  });
  return { ...result, skipped: [...skipped, ...result.skipped], windowIds: [win.id] };
}
