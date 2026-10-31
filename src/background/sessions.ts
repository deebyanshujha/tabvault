import type { Id, RecoveryOffer, RestoreResult, SavedWindow, Session, SessionKind, TimelineEntry, Workspace } from '../shared/types';
import { newId } from '../shared/ids';
import { sessionParser, workspaceParser } from '../shared/schemas';
import { autoSessionName, fingerprintOf, missingAfterRestart, snapshotsToPrune } from '../shared/sessions';
import { isNewTabUrl, urlKey } from '../shared/urls';
import { formatDateTime } from '../shared/time';
import { del, get, mutate, put, readAll, readOne, transact, request } from '../storage/db';
import { getPrefs } from '../storage/prefs';
import { broadcast } from './runtime';
import { captureAll, captureWindow, groupsById, savedGroupsFor, saveableTab, toSavedTab, type LiveWindow } from './capture';
import { openInNewWindow, openTabsInWindow } from './restore';

const STORE = 'sessions';

export const listSessions = () => readAll<Session>(STORE, sessionParser);
export const getSession = (id: Id) => readOne<Session>(STORE, id, sessionParser);

const stripLive = (w: LiveWindow | SavedWindow): SavedWindow => {
  const { chromeId: _c, ...rest } = w as LiveWindow;
  return rest;
};

export async function saveWindowsAsSession(
  windows: (SavedWindow | LiveWindow)[],
  { name, kind = 'manual', keep = false, at = Date.now() }: { name?: string; kind?: SessionKind; keep?: boolean; at?: number },
): Promise<Session> {
  const clean = windows.map(stripLive).filter((w) => w.tabs.length);
  const urls = clean.flatMap((w) => w.tabs.map((t) => t.url));
  const session: Session = {
    id: newId(),
    name: name?.trim() || autoSessionName(urls, at),
    kind,
    windows: clean,
    tabCount: urls.length,
    fingerprint: fingerprintOf(clean),
    keep,
    createdAt: at,
    updatedAt: at,
  };
  await put(STORE, session);
  broadcast('sessions');
  return session;
}

export type SaveScope = { scope: 'all' } | { scope: 'window'; windowId: number } | { scope: 'tabs'; tabIds: number[] };

export async function saveCurrent(input: SaveScope & { name?: string; close?: boolean }): Promise<Session> {
  let windows: LiveWindow[];
  if (input.scope === 'all') windows = await captureAll();
  else if (input.scope === 'window') windows = [await captureWindow(input.windowId)];
  else {
    const tabs = (await Promise.all(input.tabIds.map((id) => chrome.tabs.get(id).catch(() => null)))).filter(
      (t): t is chrome.tabs.Tab => !!t && saveableTab(t),
    );
    const groups = await groupsById();
    const byWindow = new Map<number, chrome.tabs.Tab[]>();
    for (const t of tabs) byWindow.set(t.windowId, [...(byWindow.get(t.windowId) ?? []), t]);
    windows = [...byWindow.entries()].map(([chromeId, list]) => ({
      id: newId(), chromeId, focused: false, tabs: list.map((t) => toSavedTab(t)), groups: savedGroupsFor(list, groups),
    }));
  }
  if (!windows.some((w) => w.tabs.length)) throw new Error('There are no saveable tabs here.');
  const session = await saveWindowsAsSession(windows, { name: input.name, kind: 'manual' });
  if (input.close) {
    const ids = input.scope === 'tabs'
      ? input.tabIds
      : (await chrome.tabs.query(input.scope === 'window' ? { windowId: input.windowId } : {})).filter(saveableTab).map((t) => t.id!);
    // Keep the window alive: closing every tab would close it and any unsaved chrome:// pages.
    const scopeWindow = input.scope === 'window' ? input.windowId : undefined;
    if (scopeWindow !== undefined) {
      const remaining = await chrome.tabs.query({ windowId: scopeWindow });
      if (remaining.every((t) => ids.includes(t.id!))) await chrome.tabs.create({ windowId: scopeWindow, active: true });
    }
    await chrome.tabs.remove(ids).catch(() => undefined);
  }
  return session;
}

export async function updateSessionFromCurrent(id: Id, windowId?: number): Promise<void> {
  const windows = windowId !== undefined ? [await captureWindow(windowId)] : await captureAll();
  const clean = windows.map(stripLive);
  await mutate<Session>(STORE, id, (s) =>
    s && {
      ...s,
      windows: clean,
      tabCount: clean.reduce((n, w) => n + w.tabs.length, 0),
      fingerprint: fingerprintOf(clean),
      updatedAt: Date.now(),
    },
  );
  broadcast('sessions');
}

export async function patchSession(id: Id, patch: { name?: string; keep?: boolean }): Promise<void> {
  await mutate<Session>(STORE, id, (s) => s && { ...s, ...patch, updatedAt: Date.now() });
  broadcast('sessions');
}

export async function removeSessionTabs(id: Id, tabIds: Id[]): Promise<void> {
  const drop = new Set(tabIds);
  await mutate<Session>(STORE, id, (s) => {
    if (!s) return undefined;
    const windows = s.windows.map((w) => ({ ...w, tabs: w.tabs.filter((t) => !drop.has(t.id)) })).filter((w) => w.tabs.length);
    return { ...s, windows, tabCount: windows.reduce((n, w) => n + w.tabs.length, 0), fingerprint: fingerprintOf(windows), updatedAt: Date.now() };
  });
  broadcast('sessions');
}

export async function softDeleteSession(id: Id): Promise<void> {
  await mutate<Session>(STORE, id, (s) => s && { ...s, deletedAt: Date.now() });
  broadcast('sessions');
}

export async function restoreSessionFromTrash(id: Id): Promise<void> {
  await mutate<Session>(STORE, id, (s) => {
    if (!s) return undefined;
    const { deletedAt: _d, ...rest } = s;
    return rest;
  });
  broadcast('sessions');
}

export async function purgeSession(id: Id): Promise<void> {
  await del(STORE, id);
  broadcast('sessions');
}

export async function restoreSession(
  id: Id,
  { mode, windowId, tabIds }: { mode: 'new-windows' | 'current-window'; windowId?: number; tabIds?: Id[] },
): Promise<RestoreResult> {
  const session = await getSession(id);
  if (!session) throw new Error('That session no longer exists.');
  const pick = tabIds ? new Set(tabIds) : null;
  const windows = session.windows
    .map((w) => ({ ...w, tabs: pick ? w.tabs.filter((t) => pick.has(t.id)) : w.tabs }))
    .filter((w) => w.tabs.length);
  const total: RestoreResult = { opened: 0, skipped: [], windowIds: [] };
  const add = (r: RestoreResult) => {
    total.opened += r.opened;
    total.skipped.push(...r.skipped);
    total.windowIds.push(...r.windowIds);
  };
  if (mode === 'current-window') {
    const target = windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id!;
    add(await openTabsInWindow(target, windows.flatMap((w) => w.tabs), windows.flatMap((w) => w.groups), { activeIndex: 0 }));
  } else {
    for (const w of windows) add(await openInNewWindow(w.tabs, w.groups));
  }
  return total;
}

export async function sessionToWorkspace(id: Id, name: string): Promise<Workspace> {
  const session = await getSession(id);
  if (!session) throw new Error('That session no longer exists.');
  const workspaces = await readAll<Workspace>('workspaces', workspaceParser);
  const now = Date.now();
  const ws: Workspace = {
    id: newId(),
    name,
    color: 'blue',
    icon: 'layers',
    items: session.windows.flatMap((w) => w.tabs),
    groups: session.windows.flatMap((w) => w.groups),
    autoSync: true,
    order: workspaces.reduce((max, w) => Math.max(max, w.order + 1), 0),
    createdAt: now,
    updatedAt: now,
  };
  await put('workspaces', ws);
  broadcast('workspaces');
  return ws;
}

// ---- Time Machine ----

export async function takeSnapshot(windows: LiveWindow[]): Promise<Session | null> {
  const prefs = await getPrefs();
  if (!prefs.timeMachine) return null;
  const clean = windows.map(stripLive).filter((w) => w.tabs.length);
  if (!clean.length) return null;
  const all = await listSessions();
  const autos = all.filter((s) => s.kind === 'auto');
  const latest = autos.reduce<Session | null>((a, b) => (!a || b.createdAt > a.createdAt ? b : a), null);
  if (latest && latest.fingerprint === fingerprintOf(clean)) return null;
  const session = await saveWindowsAsSession(clean, { kind: 'auto' });
  const prune = snapshotsToPrune([...autos, session]);
  if (prune.length) await del(STORE, prune);
  return session;
}

/** Unique URLs across snapshots, newest first, for "that tab I had last week" search. */
export function buildTimeline(sessions: Session[], limit = 3000): TimelineEntry[] {
  const seen = new Set<string>();
  const out: TimelineEntry[] = [];
  const autos = sessions.filter((s) => s.kind === 'auto' && !s.deletedAt).sort((a, b) => b.createdAt - a.createdAt);
  for (const session of autos) {
    for (const win of session.windows) {
      for (const tab of win.tabs) {
        const key = urlKey(tab.url);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ url: tab.url, title: tab.title, lastSeenAt: session.createdAt, sessionId: session.id });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

// ---- Restart recovery ----

export interface LiveState {
  at: number;
  windows: LiveWindow[];
}
export const LIVE_KEY = 'liveState';
export const PREVIOUS_KEY = 'previousRun';
export const RECOVERY_KEY = 'recovery';

export const getRecoveryOffer = () => get<RecoveryOffer>('kv', RECOVERY_KEY);

/**
 * Run once per browser run, before anything can overwrite the last known state.
 * Moves "what was open at the end of the last run" aside for the recovery check.
 */
export async function archiveLastRun(): Promise<void> {
  await transact('kv', 'readwrite', async (tx) => {
    const kv = tx.objectStore('kv');
    const live = await request(kv.get(LIVE_KEY));
    if (live) {
      await request(kv.put(live, PREVIOUS_KEY));
      await request(kv.delete(LIVE_KEY));
    }
  });
}

/**
 * Compare last run with what's open now. Chrome's own "continue where you left off"
 * may have brought everything back, in which case there's nothing to offer.
 */
export async function checkForRecovery(): Promise<RecoveryOffer | null> {
  const previous = await get<LiveState>('kv', PREVIOUS_KEY);
  if (!previous?.windows?.length) return null;
  await del('kv', PREVIOUS_KEY);

  const current = (await chrome.tabs.query({})).map((t) => ({ url: t.pendingUrl || t.url || '' })).filter((t) => !isNewTabUrl(t.url));
  const windows: SavedWindow[] = [];
  let total = 0;
  let missingCount = 0;
  let remaining = current;
  for (const w of previous.windows) {
    total += w.tabs.length;
    const missing = missingAfterRestart(w.tabs, remaining);
    const missingIds = new Set(missing.map((t) => t.id));
    // Tabs that matched are consumed so a later window can't claim them too.
    const matched = w.tabs.filter((t) => !missingIds.has(t.id)).map((t) => urlKey(t.url));
    remaining = consume(remaining, matched);
    if (missing.length) {
      const keys = new Set(missing.map((t) => t.groupKey).filter(Boolean));
      windows.push({ ...stripLive(w), tabs: missing, groups: w.groups.filter((g) => keys.has(g.key)) });
      missingCount += missing.length;
    }
  }
  if (missingCount < 2) return null;
  const session = await saveWindowsAsSession(windows, {
    kind: 'recovery',
    name: `Before restart · ${formatDateTime(previous.at)}`,
    at: previous.at,
    keep: true,
  });
  const offer: RecoveryOffer = { sessionId: session.id, missing: missingCount, total, at: previous.at };
  await put('kv', offer, RECOVERY_KEY);
  broadcast('recovery', 'sessions');
  return offer;
}

function consume(tabs: { url: string }[], keys: string[]): { url: string }[] {
  const out = [...tabs];
  for (const key of keys) {
    const i = out.findIndex((t) => urlKey(t.url) === key);
    if (i >= 0) out.splice(i, 1);
  }
  return out;
}

export async function dismissRecovery(): Promise<void> {
  await del('kv', RECOVERY_KEY);
  broadcast('recovery');
}

export async function applyRecovery(): Promise<RestoreResult> {
  const offer = await getRecoveryOffer();
  if (!offer) throw new Error('Nothing to recover.');
  const result = await restoreSession(offer.sessionId, { mode: 'new-windows' });
  await dismissRecovery();
  return result;
}
