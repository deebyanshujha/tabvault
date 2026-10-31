import type { Id, RestoreResult, SavedGroup, SavedTab, TabColor, Workspace, WorkspaceIcon } from '../shared/types';
import { newId } from '../shared/ids';
import { urlKey } from '../shared/urls';
import { overlapRatio } from '../shared/sessions';
import { del, get, mutate, put, readAll, readOne } from '../storage/db';
import { workspaceParser } from '../shared/schemas';
import { bindWindow, broadcast, getBindings, windowForWorkspace } from './runtime';
import { captureWindow, groupsById, isSaveableUrl, savedGroupsFor, saveableTab, tabUrl, toSavedTab, isOwnPage } from './capture';
import { openInNewWindow, openTabsInWindow } from './restore';
import { saveWindowsAsSession } from './sessions';
import { getPrefs } from '../storage/prefs';

const STORE = 'workspaces';

export const listWorkspaces = () => readAll<Workspace>(STORE, workspaceParser);
export const getWorkspace = (id: Id) => readOne<Workspace>(STORE, id, workspaceParser);

async function requireWorkspace(id: Id): Promise<Workspace> {
  const ws = await getWorkspace(id);
  if (!ws || ws.deletedAt) throw new Error('That workspace no longer exists.');
  return ws;
}

function change(id: Id, fn: (ws: Workspace) => Workspace) {
  return mutate<Workspace>(STORE, id, (ws) => (ws ? { ...fn(ws), updatedAt: Date.now() } : undefined));
}

/** Drop repeats by canonical URL, keeping the first. */
function uniqueTabs(tabs: SavedTab[]): SavedTab[] {
  const seen = new Set<string>();
  return tabs.filter((t) => {
    const k = urlKey(t.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface CreateWorkspaceInput {
  name: string;
  color?: TabColor;
  icon?: WorkspaceIcon;
  fromWindowId?: number;
  tabIds?: number[];
  links?: { url: string; title: string }[];
  bind?: boolean;
}

export async function createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
  const now = Date.now();
  const existing = await listWorkspaces();
  let items: SavedTab[] = [];
  let groups: SavedGroup[] = [];
  if (input.fromWindowId !== undefined) {
    const win = await captureWindow(input.fromWindowId);
    items = win.tabs;
    groups = win.groups;
  } else if (input.tabIds?.length) {
    const tabs = await tabsByIds(input.tabIds);
    items = tabs.filter(saveableTab).map((t) => toSavedTab(t, now));
    groups = savedGroupsFor(tabs, await groupsById());
  }
  for (const link of input.links ?? []) {
    if (isSaveableUrl(link.url)) items.push({ id: newId(), url: link.url, title: link.title || link.url, pinned: false, addedAt: now });
  }
  const ws: Workspace = {
    id: newId(),
    name: input.name,
    color: input.color ?? 'blue',
    icon: input.icon ?? 'layers',
    items,
    groups,
    autoSync: true,
    order: existing.reduce((max, w) => Math.max(max, w.order + 1), 0),
    createdAt: now,
    updatedAt: now,
  };
  await put(STORE, ws);
  if (input.bind && input.fromWindowId !== undefined) await bindWorkspace(input.fromWindowId, ws.id);
  broadcast('workspaces');
  return ws;
}

async function tabsByIds(ids: number[]): Promise<chrome.tabs.Tab[]> {
  const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id).catch(() => null)));
  return tabs.filter((t): t is chrome.tabs.Tab => !!t);
}

export async function updateWorkspace(
  id: Id,
  patch: { name?: string; color?: TabColor; icon?: WorkspaceIcon; autoSync?: boolean },
): Promise<void> {
  await change(id, (ws) => ({ ...ws, ...patch }));
  broadcast('workspaces');
}

/** Soft delete: goes to Trash for 30 days, and the window becomes an ordinary one. */
export async function deleteWorkspace(id: Id): Promise<void> {
  const windowId = await windowForWorkspace(id);
  if (windowId !== null) await bindWindow(windowId, null);
  await change(id, (ws) => ({ ...ws, deletedAt: Date.now() }));
  broadcast('workspaces', 'bindings');
}

export async function restoreWorkspaceFromTrash(id: Id): Promise<void> {
  await change(id, ({ deletedAt: _deleted, ...ws }) => ws);
  broadcast('workspaces');
}

export async function purgeWorkspace(id: Id): Promise<void> {
  await del(STORE, id);
  broadcast('workspaces');
}

export interface AddTabsResult {
  added: number;
  /** Tabs moved into the workspace's open window. */
  moved: number;
  already: number;
}

export async function addTabsToWorkspace(id: Id, tabIds: number[], { close = false }: { close?: boolean } = {}): Promise<AddTabsResult> {
  const target = await requireWorkspace(id);
  const tabs = (await tabsByIds(tabIds)).filter(saveableTab);

  // A live workspace mirrors its window, so a tab belongs to it by being in that window.
  // Writing only to the saved list would be undone by the next sync.
  const liveWindow = target.autoSync ? await windowForWorkspace(id) : null;
  if (liveWindow !== null && (await chrome.windows.get(liveWindow).catch(() => null))) {
    const elsewhere = tabs.filter((t) => t.windowId !== liveWindow).map((t) => t.id!);
    if (elsewhere.length) await chrome.tabs.move(elsewhere as [number, ...number[]], { windowId: liveWindow, index: -1 });
    await syncBoundWindows([liveWindow]);
    return { added: 0, moved: elsewhere.length, already: tabs.length - elsewhere.length };
  }

  const knownKeys = new Set(target.items.map((t) => urlKey(t.url)));
  const fresh = new Set(tabs.map((t) => urlKey(tabUrl(t))).filter((k) => !knownKeys.has(k)));
  const now = Date.now();
  const groups = await groupsById();
  await change(id, (ws) => {
    const known = new Set(ws.groups.map((g) => g.key));
    return {
      ...ws,
      items: uniqueTabs([...ws.items, ...tabs.map((t) => toSavedTab(t, now))]),
      groups: [...ws.groups, ...savedGroupsFor(tabs, groups).filter((g) => !known.has(g.key))],
    };
  });
  if (close) await chrome.tabs.remove(tabs.map((t) => t.id!).filter((x) => x !== undefined)).catch(() => undefined);
  broadcast('workspaces');
  return { added: fresh.size, moved: 0, already: tabs.length - fresh.size };
}

/** Returns false when the address can't be kept: blank pages and TabVault's own pages. */
export async function addLinkToWorkspace(id: Id, url: string, title: string): Promise<boolean> {
  await requireWorkspace(id);
  if (!isSaveableUrl(url)) return false;
  const item: SavedTab = { id: newId(), url, title: title || url, pinned: false, addedAt: Date.now() };
  await change(id, (ws) => ({ ...ws, items: uniqueTabs([...ws.items, item]) }));
  // If the workspace is live in a window, a saved list that disagrees with the
  // window would be overwritten at the next sync. Open it there instead.
  const windowId = await windowForWorkspace(id);
  if (windowId !== null) {
    const open = await chrome.tabs.query({ windowId }).catch(() => [] as chrome.tabs.Tab[]);
    const key = urlKey(url);
    if (!open.some((t) => urlKey(tabUrl(t)) === key)) await chrome.tabs.create({ windowId, url, active: false }).catch(() => undefined);
  }
  broadcast('workspaces');
  return true;
}

/** Clears TabVault's own pages out of workspaces saved before they were refused. */
export async function removeOwnPageItems(): Promise<void> {
  for (const ws of await listWorkspaces()) {
    if (ws.items.some((t) => isOwnPage(t.url))) await change(ws.id, (w) => ({ ...w, items: w.items.filter((t) => !isOwnPage(t.url)) }));
  }
  broadcast('workspaces');
}

export async function removeWorkspaceItems(id: Id, itemIds: Id[]): Promise<void> {
  const drop = new Set(itemIds);
  const before = await getWorkspace(id);
  await change(id, (ws) => ({ ...ws, items: ws.items.filter((t) => !drop.has(t.id)) }));
  // In a live window the list mirrors the tabs: leave the tab open and the next sync re-adds it.
  const windowId = await windowForWorkspace(id);
  if (windowId !== null && before?.autoSync) {
    const urls = new Set(before.items.filter((t) => drop.has(t.id)).map((t) => t.url));
    const tabs = await chrome.tabs.query({ windowId });
    const ids = tabs.filter((t) => urls.has(tabUrl(t))).map((t) => t.id!).filter((x) => x !== undefined);
    if (ids.length && ids.length < tabs.length) await chrome.tabs.remove(ids).catch(() => undefined);
  }
  broadcast('workspaces');
}

export async function reorderWorkspaceItems(id: Id, itemIds: Id[]): Promise<void> {
  await change(id, (ws) => {
    const byId = new Map(ws.items.map((t) => [t.id, t]));
    const ordered = itemIds.map((i) => byId.get(i)).filter((t): t is SavedTab => !!t);
    const rest = ws.items.filter((t) => !itemIds.includes(t.id));
    return { ...ws, items: [...ordered, ...rest] };
  });
  // Same reasoning as removal: reorder the real tabs too, in a live window.
  const windowId = await windowForWorkspace(id);
  const after = await getWorkspace(id);
  if (windowId !== null && after?.autoSync) {
    const tabs = await chrome.tabs.query({ windowId });
    for (const item of after.items) {
      const tab = tabs.find((t) => tabUrl(t) === item.url);
      if (tab?.id !== undefined) await chrome.tabs.move(tab.id, { index: -1 }).catch(() => undefined);
    }
  }
  broadcast('workspaces');
}

export async function moveWorkspaceItems(fromId: Id, toId: Id, itemIds: Id[]): Promise<void> {
  const from = await requireWorkspace(fromId);
  const moving = from.items.filter((t) => itemIds.includes(t.id));
  if ((await windowForWorkspace(toId)) !== null) {
    for (const t of moving) await addLinkToWorkspace(toId, t.url, t.title);
  } else {
    await change(toId, (ws) => ({ ...ws, items: uniqueTabs([...ws.items, ...moving.map(({ groupKey: _g, ...t }) => t)]) }));
  }
  await removeWorkspaceItems(fromId, itemIds);
}

export async function reorderWorkspaces(ids: Id[]): Promise<void> {
  await Promise.all(ids.map((id, order) => change(id, (ws) => ({ ...ws, order }))));
  broadcast('workspaces');
}

/** Overwrite the saved list from a window's current tabs. */
export async function saveWorkspaceFromWindow(id: Id, windowId: number): Promise<void> {
  const win = await captureWindow(windowId);
  await change(id, (ws) => mergeFromWindow(ws, win.tabs, win.groups));
  broadcast('workspaces');
}

/** Keep stable item ids and addedAt across syncs so ordering and history survive. */
export function mergeFromWindow(ws: Workspace, tabs: SavedTab[], groups: SavedGroup[]): Workspace {
  const known = new Map<string, SavedTab>();
  for (const item of ws.items) if (!known.has(item.url)) known.set(item.url, item);
  return {
    ...ws,
    items: tabs.map((t) => {
      const prior = known.get(t.url);
      if (!prior) return t;
      known.delete(t.url);
      return { ...t, id: prior.id, addedAt: prior.addedAt, title: t.title && t.title !== t.url ? t.title : prior.title };
    }),
    groups,
  };
}

/** Called from the debounced event pipeline for windows whose tabs changed. */
export async function syncBoundWindows(windowIds: Iterable<number>): Promise<void> {
  const bindings = await getBindings();
  let changed = false;
  for (const windowId of windowIds) {
    const id = bindings[String(windowId)];
    if (!id) continue;
    const ws = await getWorkspace(id);
    if (!ws || ws.deletedAt || !ws.autoSync) continue;
    const win = await captureWindow(windowId).catch(() => null);
    // An empty capture (window closing, or only new-tab pages) must never wipe a workspace.
    if (!win || !win.tabs.length) continue;
    await change(id, (current) => mergeFromWindow(current, win.tabs, win.groups));
    changed = true;
  }
  if (changed) broadcast('workspaces');
}

export async function bindWorkspace(windowId: number, id: Id | null): Promise<void> {
  await bindWindow(windowId, id);
  await rememberBound();
  broadcast('bindings');
}

async function rememberBound(): Promise<void> {
  const bindings = await getBindings();
  await put('kv', Object.values(bindings), 'boundWorkspaces');
}

/**
 * Window ids change across restarts, so live bindings are re-derived: a window whose
 * tabs mostly match a workspace that was live last run becomes that workspace again.
 */
export async function rebindAfterRestart(): Promise<void> {
  const previously = (await get<Id[]>('kv', 'boundWorkspaces')) ?? [];
  if (!previously.length) return;
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const bindings = await getBindings();
  const taken = new Set(Object.keys(bindings).map(Number));
  for (const id of previously) {
    if (Object.values(bindings).includes(id)) continue;
    const ws = await getWorkspace(id);
    if (!ws || ws.deletedAt || !ws.items.length) continue;
    const saved = ws.items.map((t) => t.url);
    let best: { id: number; score: number } | null = null;
    for (const win of windows) {
      if (win.id === undefined || taken.has(win.id)) continue;
      const score = overlapRatio(saved, (win.tabs ?? []).map(tabUrl));
      if (score >= 0.6 && (!best || score > best.score)) best = { id: win.id, score };
    }
    if (best) {
      await bindWindow(best.id, id);
      taken.add(best.id);
    }
  }
  await rememberBound();
  broadcast('bindings');
}

export type OpenMode = 'new-window' | 'replace' | 'append';

export interface OpenWorkspaceResult extends RestoreResult {
  focusedExisting: boolean;
  /** Session created to hold tabs that were in the window before a switch. */
  parkedSessionId?: Id;
  parkedCount?: number;
}

export async function openWorkspace(
  id: Id,
  { mode, windowId, itemIds }: { mode?: OpenMode; windowId?: number; itemIds?: Id[] },
): Promise<OpenWorkspaceResult> {
  const ws = await requireWorkspace(id);
  const chosen = mode ?? (await getPrefs()).workspaceOpenMode;
  const items = itemIds ? ws.items.filter((t) => itemIds.includes(t.id)) : ws.items;
  const partial = !!itemIds;

  // Already open somewhere: go there rather than creating a second copy.
  const live = await windowForWorkspace(id);
  if (live !== null && !partial) {
    const win = await chrome.windows.get(live).catch(() => null);
    if (win) {
      await chrome.windows.update(live, { focused: true });
      return { opened: 0, skipped: [], windowIds: [live], focusedExisting: true };
    }
    await bindWindow(live, null);
  }

  const touch = () => change(id, (w) => ({ ...w, lastOpenedAt: Date.now() }));

  if (chosen === 'append' || partial) {
    const target = windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id!;
    const result = await openTabsInWindow(target, items, ws.groups, { activeIndex: 0 });
    await touch();
    broadcast('workspaces');
    return { ...result, focusedExisting: false };
  }

  if (chosen === 'new-window') {
    const result = await openInNewWindow(items, ws.groups);
    const win = result.windowIds[0];
    if (win !== undefined) await bindWorkspace(win, id);
    await touch();
    broadcast('workspaces', 'bindings');
    return { ...result, focusedExisting: false };
  }

  return switchWindowTo(ws, windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id!, touch);
}

/**
 * The context switch: nothing is lost. The window's current tabs are saved first
 * (to the workspace it's bound to, otherwise to a "parked" session), the new tabs
 * open, and only then do the old ones close, so the window is never left empty.
 */
async function switchWindowTo(ws: Workspace, windowId: number, touch: () => Promise<unknown>): Promise<OpenWorkspaceResult> {
  const before = await chrome.tabs.query({ windowId });
  const bindings = await getBindings();
  const previous = bindings[String(windowId)];
  let parkedSessionId: Id | undefined;
  let parkedCount: number | undefined;

  const win = await captureWindow(windowId);
  if (previous) {
    if (win.tabs.length) await change(previous, (w) => mergeFromWindow(w, win.tabs, win.groups));
  } else if (win.tabs.length) {
    const session = await saveWindowsAsSession([win], { kind: 'parked' });
    parkedSessionId = session.id;
    parkedCount = session.tabCount;
  }

  // Unbind before touching tabs so the sync pipeline can't record the half-switched state.
  await bindWindow(windowId, null);

  const result = ws.items.length
    ? await openTabsInWindow(windowId, ws.items, ws.groups, { activeIndex: 0 })
    : { opened: 0, skipped: [], windowIds: [windowId] };
  if (ws.items.length && !result.opened) {
    // Nothing could open: don't trade working tabs for an empty window.
    if (previous) await bindWindow(windowId, previous);
    if (parkedSessionId) await del('sessions', parkedSessionId);
    throw new Error(`None of ${ws.name}'s tabs could be opened, so this window was left as it is.`);
  }
  if (!ws.items.length) await chrome.tabs.create({ windowId, active: true });

  // Leave TabVault's own dashboard tab alone so the user keeps their place in it.
  const toClose = before.filter((t) => !isOwnPage(tabUrl(t))).map((t) => t.id!).filter((x) => x !== undefined);
  if (toClose.length) await chrome.tabs.remove(toClose).catch(() => undefined);

  await bindWorkspace(windowId, ws.id);
  await touch();
  broadcast('workspaces', 'sessions', 'bindings');
  return { ...result, focusedExisting: false, parkedSessionId, parkedCount };
}

/** Save and close a live workspace's window. */
export async function closeWorkspaceWindow(id: Id): Promise<void> {
  const windowId = await windowForWorkspace(id);
  if (windowId === null) return;
  const ws = await getWorkspace(id);
  if (ws?.autoSync) await saveWorkspaceFromWindow(id, windowId).catch(() => undefined);
  await bindWindow(windowId, null);
  await chrome.windows.remove(windowId).catch(() => undefined);
  broadcast('bindings', 'workspaces');
}
