// Service worker entry. All listeners register synchronously at the top level so
// Chrome can wake the worker for them. No state may rely on this module staying
// loaded: timers are best-effort and swept by the `tick` alarm.

import type { Annotation, Session } from '../shared/types';
import { isNewTabUrl, isWebUrl, urlKey } from '../shared/urls';
import { DAY } from '../shared/time';
import { annotationParser, sessionParser } from '../shared/schemas';
import { del, mutate, put, readAll, get } from '../storage/db';
import { getPrefs, PREFS_KEY } from '../storage/prefs';
import { captureAll, tabUrl, isOwnPage, type LiveWindow } from './capture';
import {
  bindWindow, broadcast, forgetMru, getBindings, getTabMeta, sessionGet, sessionSet, touchMru, updateTabMeta,
} from './runtime';
import { rebindAfterRestart, syncBoundWindows, listWorkspaces, purgeWorkspace } from './workspaces';
import {
  archiveLastRun, checkForRecovery, LIVE_KEY, listSessions, saveWindowsAsSession, takeSnapshot, purgeSession, type LiveState,
} from './sessions';
import { applyRulesToTab } from './rules';
import { addTabsToLater, listLater, rescheduleSnoozes, removeLater, SNOOZE_ALARM, wakeDueSnoozes } from './later';
import { countTabClosed, countTabOpened, readActivity, recordPeak, updateFocus } from './activity';
import { handleMenuClick, rebuildMenus } from './menus';
import { dispatch, type RpcRequest } from './router';
import { refreshBadge } from './badge';
import { jumpToPreviousTab, normalTabs, openDashboard, sleepInactive } from './tabs';
import { isRestoring } from './restore';

const TICK_ALARM = 'tick';
const RECOVERY_ALARM = 'recovery-check';
const REBIND_ALARM = 'rebind';
const TICK_MINUTES = 5;
const CAPTURE_DEBOUNCE_MS = 1500;

// ---- boot: exactly once per browser run ----

let booted: Promise<void> | null = null;

/**
 * storage.session is empty only after a browser restart or an extension reload, so
 * it tells us "new run" reliably even though onStartup and tab events race on wake.
 * Everything that writes the live state awaits this first, so last run's state can't
 * be overwritten before recovery has looked at it.
 */
function ensureBoot(): Promise<void> {
  booted ??= (async () => {
    if (await sessionGet('booted', false)) return;
    await sessionSet('booted', true);
    await archiveLastRun();
    // Long enough for Chrome's own session restore to finish opening windows.
    await chrome.alarms.create(RECOVERY_ALARM, { delayInMinutes: 0.5 });
    await chrome.alarms.create(REBIND_ALARM, { delayInMinutes: 0.5 });
    await chrome.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES });
    scheduleCapture();
  })().catch((err) => {
    console.warn('[TabVault] boot failed', err);
    booted = null;
  });
  return booted;
}

// ---- debounced live capture ----

let captureTimer: ReturnType<typeof setTimeout> | undefined;
/** windowId → when its close was first seen. Entries expire in case the close event never lands. */
const closingWindows = new Map<number, number>();
const dirtyWindows = new Set<number>();
const CLOSING_TTL_MS = 5000;

function scheduleCapture(windowId?: number): void {
  if (windowId !== undefined && windowId >= 0) dirtyWindows.add(windowId);
  void sessionSet('liveDirty', true);
  clearTimeout(captureTimer);
  captureTimer = setTimeout(() => void flushCapture(), CAPTURE_DEBOUNCE_MS);
}

async function flushCapture(): Promise<void> {
  // Mid window-close the window has vanished from getAll but we haven't saved it yet.
  for (const [id, at] of closingWindows) if (Date.now() - at > CLOSING_TTL_MS) closingWindows.delete(id);
  if (closingWindows.size) {
    captureTimer = setTimeout(() => void flushCapture(), CAPTURE_DEBOUNCE_MS);
    return;
  }
  await ensureBoot();
  const windows = dirtyWindows.size ? [...dirtyWindows] : [];
  dirtyWindows.clear();
  try {
    const live = await captureAll();
    // No windows means the browser is going away. Keep the last real state for recovery.
    if (live.length) {
      const state: LiveState = { at: Date.now(), windows: live };
      await put('kv', state, LIVE_KEY);
    }
    await sessionSet('liveDirty', false);
    await sessionSet('snapshotDirty', true);
    await syncBoundWindows(windows.length ? windows : (await chrome.windows.getAll()).map((w) => w.id!));
    await recordPeak(live.reduce((n, w) => n + w.tabs.length, 0));
    await refreshBadge();
  } catch (err) {
    console.warn('[TabVault] capture failed', err);
  }
}

// ---- tab events ----

/** onUpdated can arrive before onCreated's async work finishes; this lets it wait. */
const metaReady = new Map<number, Promise<void>>();

chrome.tabs.onCreated.addListener((tab) => {
  const ready = (async () => {
    await ensureBoot();
    await countTabOpened();
    const prefs = await getPrefs();
    let fromUrl: string | undefined;
    let fromTitle: string | undefined;
    // Chrome sets an opener on blank new tabs too. Those weren't opened *by* that page,
    // so only a tab that starts on a real address counts.
    const startsBlank = !!tabUrl(tab) && isNewTabUrl(tabUrl(tab));
    if (prefs.provenance && tab.openerTabId !== undefined && !startsBlank) {
      const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
      if (opener && isWebUrl(tabUrl(opener))) {
        fromUrl = tabUrl(opener);
        fromTitle = opener.title;
      }
    }
    if (tab.id !== undefined) {
      await updateTabMeta(tab.id, () => ({ createdAt: Date.now(), ...(fromUrl ? { fromUrl, fromTitle } : {}) }));
    }
  })();
  if (tab.id !== undefined) {
    const id = tab.id;
    metaReady.set(id, ready);
    void ready.finally(() => metaReady.delete(id));
  }
  scheduleCapture(tab.windowId);
});

async function recordProvenance(tab: chrome.tabs.Tab, url: string): Promise<void> {
  const meta = (await getTabMeta())[String(tab.id)];
  if (!meta?.fromUrl || urlKey(meta.fromUrl) === urlKey(url)) return;
  const key = urlKey(url);
  const now = Date.now();
  await mutate<Annotation>('annotations', key, (a) => {
    if (a?.fromUrl) return undefined;
    return { ...(a ?? { urlKey: key, url, firstSeenAt: now }), fromUrl: meta.fromUrl, fromTitle: meta.fromTitle, updatedAt: now };
  });
  broadcast('annotations');
}

/** Only for tabs that just appeared: navigating an existing tab is never interfered with. */
async function focusExistingIfDuplicate(tab: chrome.tabs.Tab, url: string): Promise<boolean> {
  if (isRestoring() || tab.id === undefined || !isWebUrl(url)) return false;
  const prefs = await getPrefs();
  if (!prefs.focusExistingOnDuplicate) return false;
  const meta = (await getTabMeta())[String(tab.id)];
  if (!meta || Date.now() - meta.createdAt > 8000) return false;
  const key = urlKey(url);
  const others = await normalTabs();
  const existing = others.find((t) => t.id !== tab.id && urlKey(tabUrl(t)) === key);
  if (!existing?.id) return false;
  await updateTabMeta(tab.id, (m) => (m ? { ...m, createdAt: 0 } : null));
  await chrome.tabs.update(existing.id, { active: true });
  await chrome.windows.update(existing.windowId, { focused: true });
  await chrome.tabs.remove(tab.id);
  return true;
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  const relevant =
    change.url !== undefined || change.title !== undefined || change.pinned !== undefined ||
    change.groupId !== undefined || change.status === 'complete';
  if (!relevant) return;
  void (async () => {
    await ensureBoot();
    await metaReady.get(tabId);
    const url = tabUrl(tab);
    if (isOwnPage(url)) return;
    if (change.url) {
      if (await focusExistingIfDuplicate(tab, url)) return;
      if (tab.active) await updateFocus();
    }
    // A tab created with its URL may never report change.url, so also check on load.
    if ((change.url || change.status === 'complete') && isWebUrl(url) && (await getPrefs()).provenance) {
      await recordProvenance(tab, url);
    }
    if (change.url || change.status === 'complete') await applyRulesToTab(tab);
  })();
  if (tabId !== undefined) scheduleCapture(tab.windowId);
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  void (async () => {
    await ensureBoot();
    await Promise.all([countTabClosed(), forgetMru(tabId), updateTabMeta(tabId, () => null)]);
  })();
  if (info.isWindowClosing) {
    // Don't sync or re-capture here. The window's final state is the last one we saw.
    closingWindows.set(info.windowId, Date.now());
    return;
  }
  scheduleCapture(info.windowId);
});

chrome.tabs.onMoved.addListener((_id, info) => scheduleCapture(info.windowId));
chrome.tabs.onAttached.addListener((_id, info) => scheduleCapture(info.newWindowId));
chrome.tabs.onDetached.addListener((_id, info) => scheduleCapture(info.oldWindowId));
chrome.tabs.onActivated.addListener((info) => {
  void (async () => {
    await ensureBoot();
    await touchMru(info.tabId);
    await updateFocus();
  })();
});

chrome.tabGroups.onUpdated.addListener((group) => scheduleCapture(group.windowId));
chrome.tabGroups.onRemoved.addListener((group) => scheduleCapture(group.windowId));

// ---- window events ----

chrome.windows.onFocusChanged.addListener((windowId) => {
  void (async () => {
    await ensureBoot();
    await updateFocus();
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    const [tab] = await chrome.tabs.query({ windowId, active: true });
    if (tab?.id !== undefined) await touchMru(tab.id);
  })();
});

chrome.windows.onRemoved.addListener((windowId) => {
  void (async () => {
    await ensureBoot();
    try {
      const bindings = await getBindings();
      const wasBound = !!bindings[String(windowId)];
      if (wasBound) {
        await bindWindow(windowId, null);
        broadcast('bindings');
      }
      const prefs = await getPrefs();
      // A bound window is already saved in its workspace, so no second copy is needed.
      if (prefs.closedWindowGuard && !wasBound) {
        const live = await get<LiveState>('kv', LIVE_KEY);
        const win: LiveWindow | undefined = live?.windows?.find((w) => w.chromeId === windowId);
        if (win && win.tabs.length >= 2) await saveWindowsAsSession([win], { kind: 'closed-window' });
      }
    } finally {
      closingWindows.delete(windowId);
      scheduleCapture();
    }
  })();
});

chrome.idle.setDetectionInterval(120);
chrome.idle.onStateChanged.addListener(() => void updateFocus());

// ---- alarms ----

chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    await ensureBoot();
    if (alarm.name === TICK_ALARM) await tick();
    else if (alarm.name === SNOOZE_ALARM) await wakeDueSnoozes();
    else if (alarm.name === RECOVERY_ALARM) {
      await checkForRecovery();
      await refreshBadge();
    } else if (alarm.name === REBIND_ALARM) await rebindAfterRestart();
  })();
});

async function tick(): Promise<void> {
  await updateFocus(true);
  // The worker may have died before its debounce fired.
  if (await sessionGet('liveDirty', false)) await flushCapture();
  const prefs = await getPrefs();
  if (await sessionGet('snapshotDirty', false)) {
    await sessionSet('snapshotDirty', false);
    await takeSnapshot(await captureAll()).catch((err) => console.warn('[TabVault] snapshot failed', err));
  }
  if (prefs.autoSleepMinutes > 0) await sleepInactive(prefs.autoSleepMinutes);
  await maintenance();
}

async function maintenance(): Promise<void> {
  const now = Date.now();
  const last = (await get<number>('kv', 'lastMaintenance')) ?? 0;
  if (now - last < DAY) return;
  await put('kv', now, 'lastMaintenance');
  const trashCut = now - 30 * DAY;
  for (const ws of await listWorkspaces()) if (ws.deletedAt && ws.deletedAt < trashCut) await purgeWorkspace(ws.id);
  for (const s of await listSessions()) if (s.deletedAt && s.deletedAt < trashCut) await purgeSession(s.id);
  const later = await listLater();
  const oldDone = later.filter((i) => i.state === 'done' && (i.doneAt ?? 0) < trashCut).map((i) => i.id);
  if (oldDone.length) await removeLater(oldDone);
  const activityCut = new Date(now - 90 * DAY).toISOString().slice(0, 10);
  const oldDays = (await readActivity()).filter((d) => d.day < activityCut).map((d) => d.day);
  if (oldDays.length) await del('activity', oldDays);
  // Keep notes forever; provenance-only annotations can age out.
  const annotations = await readAll<Annotation>('annotations', annotationParser);
  const stale = annotations.filter((a) => !a.note && a.updatedAt < now - 60 * DAY).map((a) => a.urlKey);
  if (stale.length) await del('annotations', stale);
  // Old closed-window saves are clutter; pinned ("keep") ones stay.
  const sessions = await readAll<Session>('sessions', sessionParser);
  const oldClosed = sessions.filter((s) => s.kind === 'closed-window' && !s.keep && s.createdAt < trashCut).map((s) => s.id);
  if (oldClosed.length) await del('sessions', oldClosed);
}

// ---- commands & menus ----

chrome.commands.onCommand.addListener((command) => {
  void (async () => {
    await ensureBoot();
    if (command === 'previous-tab') await jumpToPreviousTab();
    else if (command === 'open-dashboard') await openDashboard();
    else if (command === 'save-to-later') {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab?.id !== undefined) await addTabsToLater([tab.id], { close: true });
    }
  })();
});

chrome.contextMenus.onClicked.addListener((info, tab) => void handleMenuClick(info, tab));

// ---- lifecycle ----

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await ensureBoot();
    await rebuildMenus();
    await chrome.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES });
    await rescheduleSnoozes();
    await refreshBadge();
    if (details.reason === 'install') await openDashboard();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await ensureBoot();
    await wakeDueSnoozes();
    await refreshBadge();
  })();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[PREFS_KEY]) {
    void refreshBadge();
    void updateFocus();
  }
});

// ---- messages ----

/** Only our own extension pages may call in. There are no content scripts or external callers. */
function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !sender.tab?.incognito && (sender.url ?? '').startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

chrome.runtime.onMessage.addListener((message: RpcRequest | { kind?: string }, sender, sendResponse) => {
  if (message?.kind !== 'rpc') return false;
  if (!isTrustedSender(sender)) {
    sendResponse({ ok: false, error: 'Rejected: untrusted sender' });
    return false;
  }
  const request = message as RpcRequest;
  void ensureBoot().then(async () => {
    const response = await dispatch(request);
    sendResponse(response);
    if (request.method.startsWith('workspace.') || request.method === 'data.import' || request.method === 'data.wipe') {
      await rebuildMenus().catch(() => undefined);
    }
    if (request.method.startsWith('recovery.')) await refreshBadge().catch(() => undefined);
  });
  return true; // async response
});

void ensureBoot();
