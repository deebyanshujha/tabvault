// Worker state that must survive the service worker being killed but not a browser
// restart. chrome.storage.session has exactly that lifetime. Nothing here may be
// held only in a module variable, except what's safe to lose (timers, caches).

import type { Id, TabColor, Topic } from '../shared/types';

const queues = new Map<string, Promise<unknown>>();

export async function sessionGet<T>(key: string, fallback: T): Promise<T> {
  const stored = await chrome.storage.session.get(key);
  return (stored[key] as T | undefined) ?? fallback;
}

/** Serialized per key, so two events updating the same map can't lose a write. */
export function sessionUpdate<T>(key: string, fallback: T, fn: (current: T) => T): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(async () => {
    const updated = fn(await sessionGet(key, fallback));
    await chrome.storage.session.set({ [key]: updated });
    return updated;
  });
  queues.set(key, next);
  return next;
}

export const sessionSet = (key: string, value: unknown) => sessionUpdate(key, value, () => value);

// ---- window ↔ workspace bindings ----

export type Bindings = Record<string, Id>;
const BINDINGS = 'bindings';

export const getBindings = () => sessionGet<Bindings>(BINDINGS, {});

export function bindWindow(windowId: number, workspaceId: Id | null): Promise<Bindings> {
  return sessionUpdate<Bindings>(BINDINGS, {}, (b) => {
    const next = { ...b };
    // A workspace lives in at most one window.
    for (const [w, id] of Object.entries(next)) if (id === workspaceId) delete next[w];
    if (workspaceId) next[String(windowId)] = workspaceId;
    else delete next[String(windowId)];
    return next;
  });
}

export async function windowForWorkspace(workspaceId: Id): Promise<number | null> {
  const bindings = await getBindings();
  for (const [w, id] of Object.entries(bindings)) if (id === workspaceId) return Number(w);
  return null;
}

// ---- most recently used tabs ----

const MRU = 'mru';
export const getMru = () => sessionGet<number[]>(MRU, []);
export const touchMru = (tabId: number) =>
  sessionUpdate<number[]>(MRU, [], (list) => [tabId, ...list.filter((id) => id !== tabId)].slice(0, 50));
export const forgetMru = (tabId: number) => sessionUpdate<number[]>(MRU, [], (list) => list.filter((id) => id !== tabId));

// ---- per-tab metadata ----

export interface TabMeta {
  createdAt: number;
  fromUrl?: string;
  fromTitle?: string;
  /** "ruleId|domain" entries already applied, so manual changes aren't fought. */
  applied?: string[];
}
const META = 'tabMeta';
export const getTabMeta = () => sessionGet<Record<string, TabMeta>>(META, {});
export const updateTabMeta = (tabId: number, fn: (m: TabMeta | undefined) => TabMeta | null) =>
  sessionUpdate<Record<string, TabMeta>>(META, {}, (all) => {
    const next = { ...all };
    const value = fn(all[String(tabId)]);
    if (value) next[String(tabId)] = value;
    else delete next[String(tabId)];
    return next;
  });

// ---- undo payloads ----

export interface ClosedTabRecord {
  url: string;
  title: string;
  windowId: number;
  index: number;
  pinned: boolean;
  active: boolean;
  groupTitle?: string;
  groupColor?: TabColor;
}
export interface UndoEntry {
  id: string;
  at: number;
  tabs: ClosedTabRecord[];
  laterIds?: Id[];
}
const UNDO = 'undo';
export const pushUndo = (entry: UndoEntry) => sessionUpdate<UndoEntry[]>(UNDO, [], (s) => [entry, ...s].slice(0, 20));
export async function takeUndo(id: string): Promise<UndoEntry | null> {
  const stack = await sessionGet<UndoEntry[]>(UNDO, []);
  const entry = stack.find((e) => e.id === id) ?? null;
  await sessionUpdate<UndoEntry[]>(UNDO, [], (s) => s.filter((e) => e.id !== id));
  return entry;
}

// ---- broadcast ----

/** Tell open extension pages what changed. No receiver is fine: the popup is usually closed. */
export function broadcast(...topics: Topic[]): void {
  chrome.runtime.sendMessage({ kind: 'changed', topics }).catch(() => undefined);
}
