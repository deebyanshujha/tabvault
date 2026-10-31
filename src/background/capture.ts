// Turns live Chrome windows into plain saved data. Anything read from Chrome is
// treated as possibly gone by the time we use it.

import type { SavedGroup, SavedTab, SavedWindow, TabColor } from '../shared/types';
import { isWorthSaving } from '../shared/urls';
import { newId } from '../shared/ids';
import { TAB_COLORS } from '../shared/types';

export const tabUrl = (tab: chrome.tabs.Tab) => tab.pendingUrl || tab.url || '';

export function isOwnPage(url: string): boolean {
  return url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

export const saveableTab = (tab: chrome.tabs.Tab) => {
  const url = tabUrl(tab);
  return isWorthSaving(url) && !isOwnPage(url);
};

export function asColor(color: string | undefined): TabColor {
  return TAB_COLORS.includes(color as TabColor) ? (color as TabColor) : 'grey';
}

const groupKey = (id: number) => `g${id}`;

export function toSavedTab(tab: chrome.tabs.Tab, now = Date.now()): SavedTab {
  const url = tabUrl(tab);
  const saved: SavedTab = { id: newId(), url, title: tab.title || url, pinned: !!tab.pinned, addedAt: now };
  if (typeof tab.groupId === 'number' && tab.groupId >= 0) saved.groupKey = groupKey(tab.groupId);
  return saved;
}

export async function groupsById(): Promise<Map<number, chrome.tabGroups.TabGroup>> {
  const groups = await chrome.tabGroups.query({}).catch(() => [] as chrome.tabGroups.TabGroup[]);
  return new Map(groups.map((g) => [g.id, g]));
}

export function savedGroupsFor(tabs: chrome.tabs.Tab[], groups: Map<number, chrome.tabGroups.TabGroup>): SavedGroup[] {
  const out = new Map<number, SavedGroup>();
  for (const tab of tabs) {
    const id = tab.groupId;
    if (typeof id !== 'number' || id < 0 || out.has(id)) continue;
    const g = groups.get(id);
    if (g) out.set(id, { key: groupKey(id), title: g.title ?? '', color: asColor(g.color), collapsed: !!g.collapsed });
  }
  return [...out.values()];
}

export type LiveWindow = SavedWindow & { chromeId: number };

export function toSavedWindow(win: chrome.windows.Window, groups: Map<number, chrome.tabGroups.TabGroup>, now = Date.now()): LiveWindow {
  const tabs = (win.tabs ?? []).filter(saveableTab);
  return {
    id: newId(),
    chromeId: win.id ?? -1,
    focused: !!win.focused,
    tabs: tabs.map((t) => toSavedTab(t, now)),
    groups: savedGroupsFor(tabs, groups),
  };
}

export async function captureAll(): Promise<LiveWindow[]> {
  const [windows, groups] = await Promise.all([
    chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
    groupsById(),
  ]);
  const now = Date.now();
  return windows.map((w) => toSavedWindow(w, groups, now)).filter((w) => w.tabs.length > 0);
}

export async function captureWindow(windowId: number): Promise<LiveWindow> {
  const [win, groups] = await Promise.all([chrome.windows.get(windowId, { populate: true }), groupsById()]);
  return toSavedWindow(win, groups);
}

export async function currentWindowId(): Promise<number | undefined> {
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  return win?.id;
}

// ---- typed wrappers: @types/chrome models colors as an enum and tabIds as a non-empty tuple ----

export const toChromeColor = (color: TabColor) => color as unknown as chrome.tabGroups.Color;

type TabIdList = [number, ...number[]];

export async function groupIntoNew(tabIds: number[], windowId: number): Promise<number> {
  return (await chrome.tabs.group({ tabIds: tabIds as TabIdList, createProperties: { windowId } })) as unknown as number;
}

export async function addToGroup(tabIds: number[], groupId: number): Promise<number> {
  return (await chrome.tabs.group({ tabIds: tabIds as TabIdList, groupId })) as unknown as number;
}

export async function ungroup(tabIds: number[]): Promise<void> {
  await chrome.tabs.ungroup(tabIds as TabIdList);
}
