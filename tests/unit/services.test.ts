import { beforeEach, describe, expect, it } from 'vitest';
import type { FakeBrowser } from './fake-chrome';
import { openWindow } from './fake-chrome';
import { addLinkToWorkspace, addTabsToWorkspace, createWorkspace, moveWorkspaceItems, removeWorkspaceItems, deleteWorkspace, getWorkspace, listWorkspaces, mergeFromWindow, openWorkspace, rebindAfterRestart, restoreWorkspaceFromTrash, syncBoundWindows, removeOwnPageItems } from '../../src/background/workspaces';
import {
  archiveLastRun, applyRecovery, buildTimeline, checkForRecovery, getRecoveryOffer, getSession, LIVE_KEY, listSessions, PREVIOUS_KEY, restoreSession, saveCurrent,
  sessionToWorkspace, takeSnapshot, type LiveState,
} from '../../src/background/sessions';
import { captureAll } from '../../src/background/capture';
import { addToLater, listLater, rescheduleSnoozes, SNOOZE_ALARM, wakeDueSnoozes } from '../../src/background/later';
import { closeDuplicates, closeTabs, jumpToPreviousTab, runUndo, sleepInactive } from '../../src/background/tabs';
import { exportBackup, importBackup, importLinks } from '../../src/background/backup';
import { applyRulesToTab, saveRule } from '../../src/background/rules';
import { dispatch } from '../../src/background/router';
import { openTabsInWindow, openInNewWindow } from '../../src/background/restore';
import { get, put } from '../../src/storage/db';
import { getBindings, touchMru } from '../../src/background/runtime';
import { handleMenuClick, rebuildMenus } from '../../src/background/menus';
import { countTabOpened, readActivity, updateFocus } from '../../src/background/activity';
import { getPrefs, setPrefs } from '../../src/storage/prefs';
import type { SavedTab, Session } from '../../src/shared/types';

let b: FakeBrowser;
beforeEach(() => {
  b = (globalThis as unknown as { __browser: FakeBrowser }).__browser;
});

const urlsIn = (windowId: number) => b.windows.get(windowId)!.tabs.map((t) => t.url);
const saved = (url: string, over: Partial<SavedTab> = {}): SavedTab => ({ id: url, url, title: url, pinned: false, addedAt: 0, ...over });

describe('workspaces', () => {
  it('creates from a window and binds it', async () => {
    const win = openWindow(b, ['https://a.com', 'https://b.com', 'chrome://newtab/']);
    const ws = await createWorkspace({ name: 'Dev', fromWindowId: win, bind: true });
    expect(ws.items.map((t) => t.url)).toEqual(['https://a.com', 'https://b.com']);
    expect((await getBindings())[String(win)]).toBe(ws.id);
  });

  it('sync follows the window and keeps stable ids', async () => {
    const win = openWindow(b, ['https://a.com', 'https://b.com']);
    const ws = await createWorkspace({ name: 'Dev', fromWindowId: win, bind: true });
    const idOfA = ws.items[0]!.id;
    b.windows.get(win)!.tabs.push({ id: 7777, windowId: win, index: 2, url: 'https://c.com', title: 'C', pinned: false, active: false, groupId: -1 } as chrome.tabs.Tab);
    await syncBoundWindows([win]);
    const after = (await getWorkspace(ws.id))!;
    expect(after.items.map((t) => t.url)).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
    expect(after.items[0]!.id).toBe(idOfA);
  });

  it('never wipes a workspace from an empty window', async () => {
    const win = openWindow(b, ['https://a.com']);
    const ws = await createWorkspace({ name: 'Dev', fromWindowId: win, bind: true });
    b.windows.get(win)!.tabs = [{ id: 1, windowId: win, url: 'chrome://newtab/', title: '', index: 0, pinned: false, active: true, groupId: -1 } as chrome.tabs.Tab];
    await syncBoundWindows([win]);
    expect((await getWorkspace(ws.id))!.items.map((t) => t.url)).toEqual(['https://a.com']);
  });

  it('does not sync when autoSync is off', async () => {
    const win = openWindow(b, ['https://a.com']);
    const ws = await createWorkspace({ name: 'Dev', fromWindowId: win, bind: true });
    await dispatch({ kind: 'rpc', method: 'workspace.update', params: { id: ws.id, autoSync: false } });
    b.windows.get(win)!.tabs[0]!.url = 'https://changed.com';
    await syncBoundWindows([win]);
    expect((await getWorkspace(ws.id))!.items[0]!.url).toBe('https://a.com');
  });

  it('survives a window that vanished mid-sync', async () => {
    const win = openWindow(b, ['https://a.com']);
    const ws = await createWorkspace({ name: 'Dev', fromWindowId: win, bind: true });
    b.windows.delete(win);
    await syncBoundWindows([win]);
    expect((await getWorkspace(ws.id))!.items).toHaveLength(1);
  });

  it('merge keeps the old title when the new one is just the URL', () => {
    const ws = { items: [saved('https://a.com', { title: 'Real title', id: 'keep', addedAt: 5 })], groups: [] } as never;
    const merged = mergeFromWindow(ws, [saved('https://a.com', { title: 'https://a.com', id: 'new' })], []);
    expect(merged.items[0]).toMatchObject({ id: 'keep', addedAt: 5, title: 'Real title' });
  });

  it('opening focuses the existing window instead of duplicating', async () => {
    const win = openWindow(b, ['https://a.com']);
    const ws = await createWorkspace({ name: 'Dev', fromWindowId: win, bind: true });
    const count = b.windows.size;
    const r = await openWorkspace(ws.id, { mode: 'new-window' });
    expect(r.focusedExisting).toBe(true);
    expect(b.windows.size).toBe(count);
  });

  it('re-opens in a new window if its bound window is gone', async () => {
    const win = openWindow(b, ['https://a.com']);
    const ws = await createWorkspace({ name: 'Dev', fromWindowId: win, bind: true });
    b.windows.delete(win);
    const r = await openWorkspace(ws.id, { mode: 'new-window' });
    expect(r.focusedExisting).toBe(false);
    expect(r.opened).toBe(1);
  });

  describe('switching a window', () => {
    it('parks an unbound window, then swaps tabs without losing any', async () => {
      const target = await createWorkspace({ name: 'Reading', links: [{ url: 'https://read.com', title: 'R' }, { url: 'https://book.com', title: 'B' }] });
      const win = openWindow(b, ['https://work1.com', 'https://work2.com']);
      const r = await openWorkspace(target.id, { mode: 'replace', windowId: win });
      expect(urlsIn(win)).toEqual(['https://read.com', 'https://book.com']);
      expect(r.parkedCount).toBe(2);
      const parked = (await getSession(r.parkedSessionId!))!;
      expect(parked.kind).toBe('parked');
      expect(parked.windows[0]!.tabs.map((t) => t.url)).toEqual(['https://work1.com', 'https://work2.com']);
      expect((await getBindings())[String(win)]).toBe(target.id);
    });

    it('saves back to the previous workspace and can round-trip', async () => {
      const win = openWindow(b, ['https://a.com']);
      const first = await createWorkspace({ name: 'First', fromWindowId: win, bind: true });
      const second = await createWorkspace({ name: 'Second', links: [{ url: 'https://z.com', title: 'Z' }] });
      // A tab opened since the last sync must still be saved by the switch.
      b.windows.get(win)!.tabs.push({ id: 9000, windowId: win, index: 1, url: 'https://unsynced.com', title: 'U', pinned: false, active: false, groupId: -1 } as chrome.tabs.Tab);
      const r = await openWorkspace(second.id, { mode: 'replace', windowId: win });
      expect(r.parkedCount).toBeUndefined();
      expect((await getWorkspace(first.id))!.items.map((t) => t.url)).toEqual(['https://a.com', 'https://unsynced.com']);
      expect(urlsIn(win)).toEqual(['https://z.com']);
      await openWorkspace(first.id, { mode: 'replace', windowId: win });
      expect(urlsIn(win)).toEqual(['https://a.com', 'https://unsynced.com']);
      expect((await getWorkspace(second.id))!.items.map((t) => t.url)).toEqual(['https://z.com']);
    });

    it('leaves a usable tab when the target workspace is empty', async () => {
      const empty = await createWorkspace({ name: 'Empty' });
      const win = openWindow(b, ['https://a.com']);
      await openWorkspace(empty.id, { mode: 'replace', windowId: win });
      expect(b.windows.has(win)).toBe(true);
      expect(urlsIn(win)).toEqual(['chrome://newtab/']);
    });

    it('keeps TabVault’s own dashboard tab open during a switch', async () => {
      const target = await createWorkspace({ name: 'T', links: [{ url: 'https://t.com', title: 't' }] });
      const win = openWindow(b, ['https://a.com', 'chrome-extension://tabvaulttest/dashboard.html']);
      await openWorkspace(target.id, { mode: 'replace', windowId: win });
      expect(urlsIn(win)).toContain('chrome-extension://tabvaulttest/dashboard.html');
      expect(urlsIn(win)).toContain('https://t.com');
    });

    it('leaves the window untouched if none of the new tabs can open', async () => {
      b.failUrls.add('https://broken.com');
      const target = await createWorkspace({ name: 'T', links: [{ url: 'https://broken.com', title: 'b' }] });
      const win = openWindow(b, ['https://keep.com']);
      await expect(openWorkspace(target.id, { mode: 'replace', windowId: win })).rejects.toThrow(/left as it is/);
      expect(urlsIn(win)).toEqual(['https://keep.com']);
      expect((await listSessions()).filter((s) => s.kind === 'parked')).toEqual([]);
    });

    it('stays bound to the old workspace if the switch fails', async () => {
      b.failUrls.add('https://broken.com');
      const win = openWindow(b, ['https://keep.com']);
      const current = await createWorkspace({ name: 'Current', fromWindowId: win, bind: true });
      const target = await createWorkspace({ name: 'T', links: [{ url: 'https://broken.com', title: 'b' }] });
      await expect(openWorkspace(target.id, { mode: 'replace', windowId: win })).rejects.toThrow();
      expect((await getBindings())[String(win)]).toBe(current.id);
    });
  });

  it('soft-deletes, unbinds and restores', async () => {
    const win = openWindow(b, ['https://a.com']);
    const ws = await createWorkspace({ name: 'Dev', fromWindowId: win, bind: true });
    await deleteWorkspace(ws.id);
    expect((await getWorkspace(ws.id))!.deletedAt).toBeTruthy();
    expect((await getBindings())[String(win)]).toBeUndefined();
    await expect(openWorkspace(ws.id, { mode: 'new-window' })).rejects.toThrow(/no longer exists/);
    await restoreWorkspaceFromTrash(ws.id);
    expect((await getWorkspace(ws.id))!.deletedAt).toBeUndefined();
  });

  it('removing an item from a live workspace closes its tab, so sync can’t bring it back', async () => {
    const win = openWindow(b, ['https://a.com', 'https://b.com']);
    const ws = await createWorkspace({ name: 'Dev', fromWindowId: win, bind: true });
    await removeWorkspaceItems(ws.id, [ws.items[1]!.id]);
    expect(urlsIn(win)).toEqual(['https://a.com']);
    await syncBoundWindows([win]);
    expect((await getWorkspace(ws.id))!.items.map((t) => t.url)).toEqual(['https://a.com']);
  });

  it('removing an item from a saved workspace touches no tabs', async () => {
    const win = openWindow(b, ['https://a.com']);
    const ws = await createWorkspace({ name: 'Dev', links: [{ url: 'https://a.com', title: 'a' }] });
    await removeWorkspaceItems(ws.id, [ws.items[0]!.id]);
    expect(urlsIn(win)).toEqual(['https://a.com']);
  });

  it('removing the last item never closes a live window', async () => {
    const win = openWindow(b, ['https://a.com']);
    const ws = await createWorkspace({ name: 'Dev', fromWindowId: win, bind: true });
    await removeWorkspaceItems(ws.id, [ws.items[0]!.id]);
    expect(b.windows.has(win)).toBe(true);
  });

  describe('adding tabs to a live workspace', () => {
    it('moves the tab into its window, and the add survives the next sync', async () => {
      const live = openWindow(b, ['https://a.com']);
      const ws = await createWorkspace({ name: 'Live', fromWindowId: live, bind: true });
      const other = openWindow(b, ['https://keep.com', 'https://add-me.com']);
      const tab = b.windows.get(other)!.tabs[1]!;
      expect(await addTabsToWorkspace(ws.id, [tab.id!])).toEqual({ added: 0, moved: 1, already: 0 });
      await syncBoundWindows([live]);
      expect((await getWorkspace(ws.id))!.items.map((t) => t.url)).toEqual(['https://a.com', 'https://add-me.com']);
      expect(urlsIn(live)).toContain('https://add-me.com');
      expect(urlsIn(other)).toEqual(['https://keep.com']);
    });

    it('reports a tab that is already in its window', async () => {
      const live = openWindow(b, ['https://a.com']);
      const ws = await createWorkspace({ name: 'Live', fromWindowId: live, bind: true });
      expect(await addTabsToWorkspace(ws.id, [b.windows.get(live)!.tabs[0]!.id!])).toEqual({ added: 0, moved: 0, already: 1 });
      expect(urlsIn(live)).toEqual(['https://a.com']);
    });

    it('saves to the list when its bound window has gone', async () => {
      const live = openWindow(b, ['https://a.com']);
      const ws = await createWorkspace({ name: 'Live', fromWindowId: live, bind: true });
      b.windows.delete(live);
      const other = openWindow(b, ['https://add-me.com']);
      expect(await addTabsToWorkspace(ws.id, [b.windows.get(other)!.tabs[0]!.id!])).toEqual({ added: 1, moved: 0, already: 0 });
      expect((await getWorkspace(ws.id))!.items.map((t) => t.url)).toContain('https://add-me.com');
    });

    it('a link added to it opens in its window once, not twice', async () => {
      const live = openWindow(b, ['https://a.com']);
      const ws = await createWorkspace({ name: 'Live', fromWindowId: live, bind: true });
      await addLinkToWorkspace(ws.id, 'https://a.com/', 'same page');
      await addLinkToWorkspace(ws.id, 'https://new.com', 'new');
      expect(urlsIn(live)).toEqual(['https://a.com', 'https://new.com']);
    });

    it('an item moved from another workspace survives the next sync', async () => {
      const live = openWindow(b, ['https://a.com']);
      const target = await createWorkspace({ name: 'Live', fromWindowId: live, bind: true });
      const source = await createWorkspace({ name: 'Saved', links: [{ url: 'https://moved.com', title: 'M' }] });
      await moveWorkspaceItems(source.id, target.id, [source.items[0]!.id]);
      await syncBoundWindows([live]);
      expect((await getWorkspace(target.id))!.items.map((t) => t.url)).toContain('https://moved.com');
      expect((await getWorkspace(source.id))!.items).toEqual([]);
    });
  });

  it('counts only what was really new when adding to a saved workspace', async () => {
    const ws = await createWorkspace({ name: 'Saved', links: [{ url: 'https://have.com', title: 'H' }] });
    const win = openWindow(b, ['https://have.com/', 'https://new.com']);
    expect(await addTabsToWorkspace(ws.id, b.windows.get(win)!.tabs.map((t) => t.id!))).toEqual({ added: 1, moved: 0, already: 1 });
  });

  it('does not add the same page twice', async () => {
    const win = openWindow(b, ['https://a.com', 'https://a.com/?utm_source=x']);
    const ws = await createWorkspace({ name: 'Dev' });
    await addTabsToWorkspace(ws.id, b.windows.get(win)!.tabs.map((t) => t.id!));
    expect((await getWorkspace(ws.id))!.items).toHaveLength(1);
  });

  it('re-binds windows after a restart by matching tabs', async () => {
    const ws = await createWorkspace({ name: 'Dev', links: [{ url: 'https://a.com', title: 'a' }, { url: 'https://b.com', title: 'b' }] });
    await put('kv', [ws.id], 'boundWorkspaces');
    const other = openWindow(b, ['https://x.com']);
    const match = openWindow(b, ['https://a.com', 'https://b.com', 'https://new.com']);
    await rebindAfterRestart();
    const bindings = await getBindings();
    expect(bindings[String(match)]).toBe(ws.id);
    expect(bindings[String(other)]).toBeUndefined();
  });

  it('does not bind on a weak match', async () => {
    const ws = await createWorkspace({ name: 'Dev', links: [{ url: 'https://a.com', title: 'a' }, { url: 'https://b.com', title: 'b' }, { url: 'https://c.com', title: 'c' }] });
    await put('kv', [ws.id], 'boundWorkspaces');
    openWindow(b, ['https://a.com', 'https://zzz.com']);
    await rebindAfterRestart();
    expect(Object.keys(await getBindings())).toHaveLength(0);
  });
});

describe('restoring', () => {
  it('skips unsafe and failing URLs but opens the rest', async () => {
    b.failUrls.add('https://broken.com');
    const win = openWindow(b, ['https://start.com']);
    const r = await openTabsInWindow(win, [saved('javascript:alert(1)'), saved('https://ok.com'), saved('https://broken.com'), saved('https://also-ok.com')], []);
    expect(r.opened).toBe(2);
    expect(r.skipped.map((s) => s.url)).toEqual(['javascript:alert(1)', 'https://broken.com']);
    expect(urlsIn(win)).toEqual(['https://start.com', 'https://ok.com', 'https://also-ok.com']);
  });

  it('new-window restore falls forward past a bad first URL', async () => {
    const r = await openInNewWindow([saved('data:text/html,x'), saved('https://ok.com')], []);
    expect(r.opened).toBe(1);
    expect(r.skipped).toHaveLength(1);
    expect(urlsIn(r.windowIds[0]!)).toEqual(['https://ok.com']);
  });

  it('restores pins and groups', async () => {
    const win = openWindow(b, ['https://start.com']);
    await openTabsInWindow(win, [saved('https://pin.com', { pinned: true }), saved('https://g.com', { groupKey: 'g1' })], [{ key: 'g1', title: 'Group', color: 'red', collapsed: true }]);
    const tabs = b.windows.get(win)!.tabs;
    expect(tabs.find((t) => t.url === 'https://pin.com')!.pinned).toBe(true);
    const grouped = tabs.find((t) => t.url === 'https://g.com')!;
    expect(grouped.groupId).toBeGreaterThan(0);
    expect(b.groups.get(grouped.groupId)).toMatchObject({ title: 'Group', color: 'red', collapsed: true });
  });

  it('puts large restores to sleep, leaving the active tab awake', async () => {
    const win = openWindow(b, ['https://start.com']);
    const many = Array.from({ length: 8 }, (_, i) => saved(`https://t${i}.com`));
    await openTabsInWindow(win, many, [], { activeIndex: 0 });
    const tabs = b.windows.get(win)!.tabs.filter((t) => t.url !== 'https://start.com');
    expect(tabs.filter((t) => t.discarded)).toHaveLength(7);
    expect(tabs.find((t) => t.active)!.discarded).toBe(false);
  });

  it('keeps small restores awake', async () => {
    const win = openWindow(b, ['https://start.com']);
    await openTabsInWindow(win, [saved('https://a.com'), saved('https://b.com')], []);
    expect(b.windows.get(win)!.tabs.some((t) => t.discarded)).toBe(false);
  });
});

describe('sessions', () => {
  it('saves all windows with an automatic name', async () => {
    openWindow(b, ['https://github.com/a', 'https://github.com/b']);
    openWindow(b, ['https://docs.rs/x'], false);
    const s = await saveCurrent({ scope: 'all' });
    expect(s.tabCount).toBe(3);
    expect(s.windows).toHaveLength(2);
    expect(s.name).toMatch(/^github\.com/);
    expect(s.windows[0]).not.toHaveProperty('chromeId');
  });

  it('refuses to save nothing', async () => {
    openWindow(b, ['chrome://newtab/']);
    await expect(saveCurrent({ scope: 'all' })).rejects.toThrow(/no saveable/i);
  });

  it('close keeps the window alive', async () => {
    const win = openWindow(b, ['https://a.com', 'https://b.com']);
    await saveCurrent({ scope: 'window', windowId: win, close: true });
    expect(b.windows.has(win)).toBe(true);
    expect(urlsIn(win)).toEqual(['chrome://newtab/']);
  });

  it('restores only selected tabs', async () => {
    const win = openWindow(b, ['https://a.com', 'https://b.com', 'https://c.com']);
    const s = await saveCurrent({ scope: 'window', windowId: win });
    const pick = s.windows[0]!.tabs[1]!.id;
    const target = openWindow(b, ['https://start.com']);
    const r = await restoreSession(s.id, { mode: 'current-window', windowId: target, tabIds: [pick] });
    expect(r.opened).toBe(1);
    expect(urlsIn(target)).toEqual(['https://start.com', 'https://b.com']);
  });

  it('reports a missing session', async () => {
    await expect(restoreSession('nope', { mode: 'new-windows' })).rejects.toThrow(/no longer exists/);
  });

  it('becomes a workspace', async () => {
    const win = openWindow(b, ['https://a.com']);
    const s = await saveCurrent({ scope: 'window', windowId: win });
    const ws = await sessionToWorkspace(s.id, 'From session');
    expect((await listWorkspaces()).map((w) => w.id)).toContain(ws.id);
    expect(ws.items[0]!.url).toBe('https://a.com');
  });

  it('skips snapshots when nothing changed', async () => {
    openWindow(b, ['https://a.com']);
    const first = await takeSnapshot(await captureAll());
    expect(first).not.toBeNull();
    expect(await takeSnapshot(await captureAll())).toBeNull();
    b.windows.values().next().value!.tabs.push({ id: 55, windowId: 1000, index: 1, url: 'https://new.com', title: 'N', pinned: false, active: false, groupId: -1 } as chrome.tabs.Tab);
    expect(await takeSnapshot(await captureAll())).not.toBeNull();
    expect((await listSessions()).filter((s) => s.kind === 'auto')).toHaveLength(2);
  });

  it('respects the Time Machine setting', async () => {
    await setPrefs({ timeMachine: false });
    openWindow(b, ['https://a.com']);
    expect(await takeSnapshot(await captureAll())).toBeNull();
  });

  it('builds a de-duplicated timeline, newest first', () => {
    const make = (id: string, at: number, urls: string[]): Session => ({
      id, name: id, kind: 'auto', keep: false, createdAt: at, updatedAt: at, fingerprint: '', tabCount: urls.length,
      windows: [{ id: 'w', focused: false, groups: [], tabs: urls.map((u) => saved(u)) }],
    });
    const timeline = buildTimeline([make('old', 1, ['https://a.com', 'https://b.com']), make('new', 2, ['https://a.com/'])]);
    expect(timeline.map((t) => [t.url, t.sessionId])).toEqual([['https://a.com/', 'new'], ['https://b.com', 'old']]);
  });
});

describe('restart recovery', () => {
  const lastRun = (urls: string[]): LiveState => ({
    at: 1000,
    windows: [{ id: 'w', chromeId: 1, focused: true, groups: [], tabs: urls.map((u) => saved(u)) }],
  });

  it('offers what did not come back', async () => {
    await put('kv', lastRun(['https://a.com', 'https://b.com', 'https://c.com']), LIVE_KEY);
    await archiveLastRun();
    expect(await get('kv', LIVE_KEY)).toBeUndefined();
    openWindow(b, ['https://a.com']);
    const offer = await checkForRecovery();
    expect(offer).toMatchObject({ missing: 2, total: 3 });
    const session = (await getSession(offer!.sessionId))!;
    expect(session.kind).toBe('recovery');
    expect(session.keep).toBe(true);
    expect(session.windows[0]!.tabs.map((t) => t.url)).toEqual(['https://b.com', 'https://c.com']);
  });

  it('stays quiet when Chrome brought everything back', async () => {
    await put('kv', lastRun(['https://a.com', 'https://b.com']), LIVE_KEY);
    await archiveLastRun();
    openWindow(b, ['https://a.com/', 'https://b.com']);
    expect(await checkForRecovery()).toBeNull();
    expect(await getRecoveryOffer()).toBeUndefined();
  });

  it('stays quiet for a single lost tab, and on a first run', async () => {
    await put('kv', lastRun(['https://a.com']), LIVE_KEY);
    await archiveLastRun();
    expect(await checkForRecovery()).toBeNull();
    expect(await checkForRecovery()).toBeNull();
  });

  it('only offers once per restart', async () => {
    await put('kv', lastRun(['https://a.com', 'https://b.com']), LIVE_KEY);
    await archiveLastRun();
    expect(await checkForRecovery()).not.toBeNull();
    expect(await checkForRecovery()).toBeNull();
    expect(await get('kv', PREVIOUS_KEY)).toBeUndefined();
  });

  it('archiving twice does not lose the state', async () => {
    await put('kv', lastRun(['https://a.com', 'https://b.com']), LIVE_KEY);
    await archiveLastRun();
    await archiveLastRun();
    expect(await get('kv', PREVIOUS_KEY)).toBeDefined();
  });

  it('restores and clears the offer', async () => {
    await put('kv', lastRun(['https://a.com', 'https://b.com']), LIVE_KEY);
    await archiveLastRun();
    await checkForRecovery();
    const r = await applyRecovery();
    expect(r.opened).toBe(2);
    expect(await getRecoveryOffer()).toBeUndefined();
  });

  it('treats two windows of the same page correctly', async () => {
    const state: LiveState = {
      at: 1, windows: [
        { id: 'a', chromeId: 1, focused: true, groups: [], tabs: [saved('https://x.com'), saved('https://y.com')] },
        { id: 'b', chromeId: 2, focused: false, groups: [], tabs: [saved('https://x.com'), saved('https://z.com')] },
      ],
    };
    await put('kv', state, LIVE_KEY);
    await archiveLastRun();
    openWindow(b, ['https://x.com']);
    const offer = await checkForRecovery();
    expect(offer!.missing).toBe(3);
  });
});

describe('tabs', () => {
  it('close then undo puts tabs back', async () => {
    const win = openWindow(b, ['https://a.com', 'https://b.com', 'https://c.com']);
    const ids = b.windows.get(win)!.tabs.slice(1).map((t) => t.id!);
    const r = await closeTabs(ids);
    expect(r.closed).toBe(2);
    expect(urlsIn(win)).toEqual(['https://a.com']);
    const undo = await runUndo(r.undoId!);
    expect(undo.opened).toBe(2);
    expect(urlsIn(win)).toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
    await expect(runUndo(r.undoId!)).rejects.toThrow(/no longer/);
  });

  it('undo survives its window having closed', async () => {
    const win = openWindow(b, ['https://a.com']);
    const other = openWindow(b, ['https://other.com'], false);
    const r = await closeTabs(b.windows.get(win)!.tabs.map((t) => t.id!));
    expect(b.windows.has(win)).toBe(false);
    await runUndo(r.undoId!);
    expect(urlsIn(other)).toContain('https://a.com');
  });

  it('ignores ids of tabs that are already gone', async () => {
    const win = openWindow(b, ['https://a.com']);
    const r = await closeTabs([999999, b.windows.get(win)!.tabs[0]!.id!]);
    expect(r.closed).toBe(1);
    expect((await closeTabs([424242])).closed).toBe(0);
  });

  it('closes duplicates, keeping the active copy', async () => {
    const win = openWindow(b, ['https://a.com', 'https://a.com/', 'https://b.com']);
    const r = await closeDuplicates();
    expect(r.closed).toBe(1);
    expect(urlsIn(win)).toEqual(['https://a.com', 'https://b.com']);
  });

  it('sleep skips active, pinned, audible and protected tabs', async () => {
    const win = openWindow(b, ['https://active.com', 'https://sleep.com', 'https://pinned.com', 'https://audio.com', 'https://prot.com']);
    const tabs = b.windows.get(win)!.tabs;
    tabs[2]!.pinned = true;
    tabs[3]!.audible = true;
    await saveRule({ match: { kind: 'domain', value: 'prot.com' }, action: { type: 'protect' } });
    const n = await sleepInactive(0);
    expect(n).toBe(1);
    expect(tabs[1]!.discarded).toBe(true);
    expect(tabs[4]!.discarded).toBe(false);
  });
});

describe('later', () => {
  it('de-duplicates by page and refuses unsaveable ones', async () => {
    const first = await addToLater([{ url: 'https://a.com', title: 'A' }, { url: 'chrome://newtab/', title: 'x' }]);
    expect(first).toHaveLength(1);
    await addToLater([{ url: 'https://a.com/?utm_source=z', title: 'A2' }]);
    expect(await listLater()).toHaveLength(1);
  });

  it('wakes due items into tabs and schedules the next', async () => {
    const win = openWindow(b, ['https://x.com']);
    await addToLater([{ url: 'https://due.com', title: 'D' }], Date.now() - 1000);
    await addToLater([{ url: 'https://future.com', title: 'F' }], Date.now() + 100000);
    expect(await wakeDueSnoozes()).toBe(1);
    expect(urlsIn(win)).toContain('https://due.com');
    expect(urlsIn(win)).not.toContain('https://future.com');
    expect(b.alarms.has(SNOOZE_ALARM)).toBe(true);
    expect((await listLater()).find((i) => i.url === 'https://due.com')!.state).toBe('done');
  });

  it('holds due items when no window is open', async () => {
    await addToLater([{ url: 'https://due.com', title: 'D' }], Date.now() - 1000);
    expect(await wakeDueSnoozes()).toBe(0);
    expect((await listLater())[0]!.state).toBe('snoozed');
  });

  it('clears the alarm when nothing is snoozed', async () => {
    await addToLater([{ url: 'https://a.com', title: 'A' }]);
    await rescheduleSnoozes();
    expect(b.alarms.has(SNOOZE_ALARM)).toBe(false);
  });
});

describe('rules', () => {
  it('groups once, then leaves the user’s later changes alone', async () => {
    const win = openWindow(b, ['https://github.com/a']);
    await saveRule({ match: { kind: 'domain', value: 'github.com' }, action: { type: 'group', title: 'Code', color: 'blue' } });
    const tab = b.windows.get(win)!.tabs[0]!;
    await applyRulesToTab({ ...tab });
    expect(tab.groupId).toBeGreaterThan(0);
    expect(b.groups.get(tab.groupId)!.title).toBe('Code');
    tab.groupId = -1; // user drags it out of the group
    await applyRulesToTab({ ...tab });
    expect(tab.groupId).toBe(-1);
  });

  it('joins an existing group of that name', async () => {
    const win = openWindow(b, ['https://github.com/a', 'https://github.com/b']);
    await saveRule({ match: { kind: 'domain', value: 'github.com' }, action: { type: 'group', title: 'Code', color: 'blue' } });
    const [a, c] = b.windows.get(win)!.tabs;
    await applyRulesToTab({ ...a! });
    await applyRulesToTab({ ...c! });
    expect(a!.groupId).toBe(c!.groupId);
  });

  it('files into a workspace when its window is closed', async () => {
    const ws = await createWorkspace({ name: 'W' });
    const win = openWindow(b, ['https://news.com/x']);
    await saveRule({ match: { kind: 'domain', value: 'news.com' }, action: { type: 'workspace', workspaceId: ws.id } });
    await applyRulesToTab({ ...b.windows.get(win)!.tabs[0]! });
    expect((await getWorkspace(ws.id))!.items.map((t) => t.url)).toEqual(['https://news.com/x']);
  });

  it('ignores internal pages', async () => {
    const win = openWindow(b, ['chrome://settings']);
    await saveRule({ match: { kind: 'url-contains', value: 'settings' }, action: { type: 'pin' } });
    await applyRulesToTab({ ...b.windows.get(win)!.tabs[0]! });
    expect(b.windows.get(win)!.tabs[0]!.pinned).toBe(false);
  });
});

describe('browser entry points', () => {
  const click = (menuItemId: string, extra: object = {}) => handleMenuClick({ menuItemId, editable: false, pageUrl: 'https://page.com/x', ...extra } as chrome.contextMenus.OnClickData, { windowId: 1, title: 'Page title', url: 'https://page.com/x' } as chrome.tabs.Tab);

  it('context menu saves the page or the link to Later', async () => {
    await click('later-page');
    await click('later-link', { linkUrl: 'https://link.com/y' });
    expect((await listLater()).map((i) => i.url).sort()).toEqual(['https://link.com/y', 'https://page.com/x']);
  });

  it('context menu adds to a workspace', async () => {
    const ws = await createWorkspace({ name: 'W' });
    await click(`ws:${ws.id}`);
    expect((await getWorkspace(ws.id))!.items.map((t) => t.url)).toEqual(['https://page.com/x']);
  });

  it('never saves TabVault’s own pages to a workspace', async () => {
    const ws = await createWorkspace({ name: 'W', links: [{ url: 'chrome-extension://tabvaulttest/popup.html', title: 'TabVault' }] });
    expect((await getWorkspace(ws.id))!.items).toEqual([]);
    expect(await addLinkToWorkspace(ws.id, 'chrome-extension://tabvaulttest/popup.html', 'TabVault')).toBe(false);
    await handleMenuClick({ menuItemId: `ws:${ws.id}`, editable: false, pageUrl: 'chrome-extension://tabvaulttest/popup.html' } as chrome.contextMenus.OnClickData, { windowId: 1, title: 'TabVault' } as chrome.tabs.Tab);
    expect((await getWorkspace(ws.id))!.items).toEqual([]);
    expect(await addLinkToWorkspace(ws.id, 'https://real.com', 'Real')).toBe(true);
    expect((await getWorkspace(ws.id))!.items.map((t) => t.url)).toEqual(['https://real.com']);
  });

  it('cleans TabVault’s own pages out of workspaces that already hold them, keeping the rest', async () => {
    const ws = await createWorkspace({ name: 'W', links: [{ url: 'https://keep.com', title: 'Keep' }] });
    await put('workspaces', { ...(await getWorkspace(ws.id))!, items: [...(await getWorkspace(ws.id))!.items, { id: 'own', url: 'chrome-extension://tabvaulttest/popup.html', title: 'TabVault', pinned: false, addedAt: 1 }] });
    await removeOwnPageItems();
    expect((await getWorkspace(ws.id))!.items.map((t) => t.url)).toEqual(['https://keep.com']);
  });

  it('keeps page and link menu items off TabVault’s own pages', async () => {
    const made: { id: string; contexts: string[]; documentUrlPatterns?: string[] }[] = [];
    (globalThis as unknown as { chrome: { contextMenus: { create: unknown } } }).chrome.contextMenus.create = (p: (typeof made)[number], cb?: () => void) => {
      made.push(p);
      cb?.();
    };
    await createWorkspace({ name: 'W' });
    await rebuildMenus();
    const inPages = made.filter((m) => !m.contexts.includes('action'));
    expect(inPages.length).toBeGreaterThan(3);
    for (const m of inPages) {
      expect(m.documentUrlPatterns).toBeDefined();
      expect(m.documentUrlPatterns!.some((p) => p.startsWith('chrome-extension'))).toBe(false);
    }
    expect(made.filter((m) => m.contexts.includes('action')).length).toBe(2);
  });

  it('context menu saves the window as a session', async () => {
    const win = openWindow(b, ['https://a.com']);
    await handleMenuClick({ menuItemId: 'save-session', editable: false, pageUrl: 'https://a.com' } as chrome.contextMenus.OnClickData, { windowId: win } as chrome.tabs.Tab);
    expect((await listSessions()).map((s) => s.kind)).toEqual(['manual']);
  });

  it('menus rebuild with workspaces present and deleted ones gone', async () => {
    const created: string[] = [];
    (globalThis as unknown as { chrome: { contextMenus: { create: unknown } } }).chrome.contextMenus.create = (p: { id: string }, cb?: () => void) => {
      created.push(p.id);
      cb?.();
    };
    const keep = await createWorkspace({ name: 'Keep' });
    const gone = await createWorkspace({ name: 'Gone' });
    await deleteWorkspace(gone.id);
    await rebuildMenus();
    expect(created).toContain(`ws:${keep.id}`);
    expect(created).not.toContain(`ws:${gone.id}`);
  });

  it('previous-tab jumps back, skipping tabs that closed', async () => {
    const win = openWindow(b, ['https://a.com', 'https://b.com', 'https://c.com']);
    const [a, gone, c] = b.windows.get(win)!.tabs;
    await touchMru(a!.id!);
    await touchMru(gone!.id!);
    await touchMru(c!.id!);
    await chrome.tabs.remove(gone!.id!);
    await jumpToPreviousTab();
    expect(b.windows.get(win)!.tabs.find((t) => t.id === a!.id)!.active).toBe(true);
  });
});

describe('focus tracking', () => {
  const setFocus = (win: number, focused: boolean) => { b.windows.get(win)!.focused = focused; };
  const today = async () => (await readActivity())[0]!;

  it('credits time to the focused site, and only the site', async () => {
    const win = openWindow(b, ['https://github.com/secret/path?token=abc']);
    await updateFocus();
    const session = b.session.focus as { domain: string; since: number };
    expect(session.domain).toBe('github.com');
    // Pretend a minute went by, then the user moves to another window of the browser's world.
    b.session.focus = { ...session, since: Date.now() - 60_000 };
    setFocus(win, false);
    await updateFocus();
    const day = await today();
    expect(Object.keys(day.focusSeconds)).toEqual(['github.com']);
    expect(day.focusSeconds['github.com']).toBeGreaterThan(55);
    expect(JSON.stringify(day)).not.toContain('secret');
    expect(b.session.focus).toBeNull();
  });

  it('stops counting while idle', async () => {
    openWindow(b, ['https://a.com']);
    (globalThis as unknown as { chrome: { idle: { queryState: () => Promise<string> } } }).chrome.idle.queryState = async () => 'idle';
    await updateFocus();
    expect(b.session.focus ?? null).toBeNull();
  });

  it('caps a span so a missed event can’t record hours of absence', async () => {
    const win = openWindow(b, ['https://a.com']);
    await updateFocus();
    b.session.focus = { domain: 'a.com', since: Date.now() - 6 * 3_600_000 };
    setFocus(win, false);
    await updateFocus();
    expect((await today()).focusSeconds['a.com']).toBe(1800);
  });

  it('counts a long stay in full by banking it at checkpoints', async () => {
    openWindow(b, ['https://long.com']);
    await updateFocus();
    for (let i = 0; i < 3; i++) {
      const state = b.session.focus as { since: number };
      b.session.focus = { ...state, since: Date.now() - 25 * 60_000 };
      await updateFocus(true);
    }
    const day = await today();
    expect(day.focusSeconds['long.com']).toBeCloseTo(4500, -1);
    expect(day.longest).toMatchObject({ domain: 'long.com' });
    expect(day.longest!.seconds).toBeCloseTo(4500, -1);
    expect(day.switches).toBe(0);
    expect(Object.values(day.hours).reduce((a, s) => a + s, 0)).toBeCloseTo(4500, -1);
  });

  it('counts a change of site as a switch and starts a new stay', async () => {
    const win = openWindow(b, ['https://one.com']);
    await updateFocus();
    b.session.focus = { ...(b.session.focus as object), since: Date.now() - 120_000 };
    b.windows.get(win)!.tabs[0]!.url = 'https://two.com';
    await updateFocus();
    const day = await today();
    expect(day.switches).toBe(1);
    expect(day.longest).toMatchObject({ domain: 'one.com' });
    expect(b.session.focus).toMatchObject({ domain: 'two.com' });
    expect((b.session.focus as { run?: number }).run).toBeUndefined();
  });

  it('records nothing when turned off', async () => {
    await setPrefs({ activity: false });
    openWindow(b, ['https://a.com']);
    await updateFocus();
    await countTabOpened();
    expect(await readActivity()).toEqual([]);
  });

  it('ignores browser pages', async () => {
    openWindow(b, ['chrome://settings']);
    await updateFocus();
    expect(b.session.focus ?? null).toBeNull();
  });
});

describe('backup', () => {
  it('round-trips through export and import, without Time Machine bulk', async () => {
    const win = openWindow(b, ['https://a.com']);
    const ws = await createWorkspace({ name: 'W', fromWindowId: win });
    const s = await saveCurrent({ scope: 'all', name: 'Keep me' });
    await takeSnapshot(await captureAll());
    const backup = await exportBackup();
    expect(backup.data.sessions.map((x) => x.id)).toEqual([s.id]);
    await dispatch({ kind: 'rpc', method: 'data.wipe', params: {} });
    expect(await listWorkspaces()).toEqual([]);
    const summary = await importBackup(JSON.stringify(backup));
    expect(summary).toMatchObject({ workspaces: 1, sessions: 1, rejected: 0 });
    expect((await getWorkspace(ws.id))!.name).toBe('W');
  });

  it('rejects things that are not backups', async () => {
    await expect(importBackup('not json')).rejects.toThrow(/valid JSON/);
    await expect(importBackup('{"format":"other"}')).rejects.toThrow(/isn’t a TabVault backup/);
    await expect(importBackup('null')).rejects.toThrow(/isn’t a TabVault backup/);
  });

  it('refuses a backup from a newer version', async () => {
    await expect(importBackup(JSON.stringify({ format: 'tabvault-backup', schemaVersion: 999, data: {} }))).rejects.toThrow(/newer version/);
  });

  it('skips bad records, keeps good ones, and neutralizes unsafe URLs', async () => {
    const summary = await importBackup(JSON.stringify({
      format: 'tabvault-backup', schemaVersion: 1,
      data: {
        workspaces: [
          { id: 'ok', name: 'OK', items: [{ url: 'javascript:alert(1)' }, { url: 'https://fine.com' }] },
          { name: 'no id' }, 'garbage', null,
        ],
        later: [{ id: 'evil', url: 'data:text/html,<script>1</script>' }],
        rules: [{ id: 'r', match: { kind: 'regex', value: '(a+)+' }, action: { type: 'pin' } }],
      },
    }));
    expect(summary.workspaces).toBe(1);
    expect(summary.rejected).toBe(5);
    expect((await getWorkspace('ok'))!.items.map((t) => t.url)).toEqual(['https://fine.com']);
    expect(await listLater()).toEqual([]);
  });

  it('on a clash, the newer version wins and others are untouched', async () => {
    const base = { id: 'w', name: 'Old', updatedAt: 100, createdAt: 1 };
    await importBackup(JSON.stringify({ format: 'tabvault-backup', schemaVersion: 1, data: { workspaces: [base, { ...base, id: 'other', name: 'Other' }] } }));
    await importBackup(JSON.stringify({ format: 'tabvault-backup', schemaVersion: 1, data: { workspaces: [{ ...base, name: 'Stale', updatedAt: 50 }] } }));
    expect((await getWorkspace('w'))!.name).toBe('Old');
    await importBackup(JSON.stringify({ format: 'tabvault-backup', schemaVersion: 1, data: { workspaces: [{ ...base, name: 'New', updatedAt: 200 }] } }));
    expect((await getWorkspace('w'))!.name).toBe('New');
    expect((await getWorkspace('other'))!.name).toBe('Other');
  });

  it('imports prefs safely', async () => {
    await importBackup(JSON.stringify({ format: 'tabvault-backup', schemaVersion: 1, data: { prefs: { theme: 'dark', evil: 1, staleDays: -4 } } }));
    const prefs = await getPrefs();
    expect(prefs.theme).toBe('dark');
    expect(prefs.staleDays).toBe(1);
    expect('evil' in prefs).toBe(false);
  });

  it('imports link lists as sessions', async () => {
    const r = await importLinks('https://a.com | A\n\nhttps://b.com\nnope');
    expect(r).toMatchObject({ tabs: 2, ignored: 1 });
    const s = (await getSession(r.sessionId))!;
    expect(s.kind).toBe('imported');
    expect(s.windows).toHaveLength(2);
    await expect(importLinks('nothing useful')).rejects.toThrow(/No usable links/);
  });
});

describe('message router', () => {
  it('rejects unknown methods, including prototype names', async () => {
    for (const method of ['nope', 'constructor', '__proto__', 'toString']) {
      expect(await dispatch({ kind: 'rpc', method, params: {} })).toMatchObject({ ok: false });
    }
  });

  it('rejects invalid params before running anything', async () => {
    const r = await dispatch({ kind: 'rpc', method: 'tabs.close', params: { tabIds: 'all' } });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/tabIds/);
    expect(await dispatch({ kind: 'rpc', method: 'tabs.open', params: { url: 'javascript:alert(1)' } })).toMatchObject({ ok: false });
    expect(await dispatch({ kind: 'rpc', method: 'workspace.create', params: { name: '   ' } })).toMatchObject({ ok: false });
  });

  it('reports failures as errors rather than throwing', async () => {
    expect(await dispatch({ kind: 'rpc', method: 'workspace.open', params: { id: 'missing' } })).toMatchObject({ ok: false, error: expect.stringMatching(/no longer exists/) });
  });

  it('returns a complete vault on an empty install', async () => {
    const r = await dispatch({ kind: 'rpc', method: 'vault.read', params: {} });
    expect(r).toMatchObject({ ok: true, data: { workspaces: [], sessions: [], later: [], recovery: null } });
  });

  it('hides deleted items from the vault but lists them in trash', async () => {
    const ws = await createWorkspace({ name: 'W' });
    await deleteWorkspace(ws.id);
    const r = await dispatch({ kind: 'rpc', method: 'vault.read', params: {} }) as { data: { workspaces: unknown[]; trash: { workspaces: unknown[] } } };
    expect(r.data.workspaces).toEqual([]);
    expect(r.data.trash.workspaces).toHaveLength(1);
  });

  it('notes can be set, cleared and survive for search', async () => {
    await dispatch({ kind: 'rpc', method: 'note.set', params: { url: 'https://a.com/?utm_source=x', text: ' deadline Friday ' } });
    let vault = await dispatch({ kind: 'rpc', method: 'vault.read', params: {} }) as { data: { annotations: { urlKey: string; note?: string }[] } };
    expect(vault.data.annotations[0]).toMatchObject({ urlKey: 'a.com', note: 'deadline Friday' });
    await dispatch({ kind: 'rpc', method: 'note.set', params: { url: 'https://a.com', text: '' } });
    vault = await dispatch({ kind: 'rpc', method: 'vault.read', params: {} }) as typeof vault;
    expect(vault.data.annotations[0]!.note).toBeUndefined();
  });
});

describe('large sessions', () => {
  it('handles 2000 tabs across windows', async () => {
    for (let w = 0; w < 10; w++) {
      openWindow(b, Array.from({ length: 200 }, (_, i) => `https://site${i % 40}.com/w${w}/p${i}`), w === 0);
    }
    const start = performance.now();
    const s = await saveCurrent({ scope: 'all' });
    const vault = await dispatch({ kind: 'rpc', method: 'vault.read', params: {} });
    expect(s.tabCount).toBe(2000);
    expect(vault.ok).toBe(true);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
