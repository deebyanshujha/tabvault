// The only way into the worker from extension pages. Every method declares a parser
// for its params; the types the UI sees are derived from this table.

import { array, boolean, integer, nonEmpty, number, object, oneOf, optional, string, union, type Parser } from '../shared/validate';
import { colorParser, iconParser, ruleActionParser, ruleMatchParser, urlParser } from '../shared/schemas';
import type { Annotation, DayActivity, VaultState } from '../shared/types';
import { annotationParser } from '../shared/schemas';
import { summarize } from '../shared/sessions';
import { urlKey } from '../shared/urls';
import { countQuarantined, mutate, readAll } from '../storage/db';
import * as tabs from './tabs';
import * as ws from './workspaces';
import * as sessions from './sessions';
import * as later from './later';
import * as rules from './rules';
import * as backup from './backup';
import { clearActivity, readActivity, updateFocus } from './activity';
import { broadcast, getBindings } from './runtime';
import { refreshBadge } from './badge';
import { captureAll } from './capture';

const id = nonEmpty(100);
const tabId = integer;
const tabIds = array(integer, 5000);
const ids = array(id, 10000);

function route<P, R>(params: Parser<P>, run: (p: P) => Promise<R>) {
  return { params, run };
}
const none = object({});

const listAnnotations = () => readAll<Annotation>('annotations', annotationParser);

async function readVault(): Promise<VaultState> {
  const [workspaces, allSessions, laterItems, annotations, ruleList, bindings, recovery, quarantined] = await Promise.all([
    ws.listWorkspaces(),
    sessions.listSessions(),
    later.listLater(),
    listAnnotations(),
    rules.listRules(),
    getBindings(),
    sessions.getRecoveryOffer(),
    countQuarantined().catch(() => 0),
  ]);
  const live = allSessions.filter((s) => !s.deletedAt);
  return {
    workspaces: workspaces.filter((w) => !w.deletedAt).sort((a, b) => a.order - b.order),
    sessions: live.map(summarize).sort((a, b) => b.createdAt - a.createdAt),
    sessionTabs: live
      .filter((s) => s.kind !== 'auto')
      .flatMap((s) => s.windows.flatMap((w) => w.tabs.map((t) => ({ sessionId: s.id, url: t.url, title: t.title })))),
    timeline: sessions.buildTimeline(allSessions),
    later: laterItems.sort((a, b) => b.addedAt - a.addedAt),
    annotations,
    rules: ruleList,
    bindings,
    recovery: recovery ?? null,
    trash: {
      workspaces: workspaces.filter((w) => w.deletedAt),
      sessions: allSessions.filter((s) => s.deletedAt).map(summarize),
    },
    quarantined,
  };
}

async function setNote(url: string, text: string): Promise<void> {
  const key = urlKey(url);
  const note = text.trim();
  const now = Date.now();
  await mutate<Annotation>('annotations', key, (a) => {
    const base: Annotation = a ?? { urlKey: key, url, firstSeenAt: now, updatedAt: now };
    const { note: _old, ...rest } = base;
    return { ...rest, updatedAt: now, ...(note ? { note } : {}) };
  });
  broadcast('annotations');
}

const workspaceMode = oneOf(['new-window', 'replace', 'append'] as const);

export const handlers = {
  // ---- reads ----
  'vault.read': route(none, readVault),
  'insights.read': route(none, async (): Promise<DayActivity[]> => {
    await updateFocus(true);
    return (await readActivity()).sort((a, b) => a.day.localeCompare(b.day));
  }),
  'tabs.recentlyClosed': route(none, () => tabs.recentlyClosed()),

  // ---- tabs ----
  'tabs.focus': route(object({ tabId }), (p) => tabs.focusTab(p.tabId)),
  'tabs.open': route(object({ url: urlParser, active: optional(boolean), windowId: optional(integer) }), async (p) => {
    await chrome.tabs.create({ url: p.url, active: p.active ?? true, ...(p.windowId !== undefined ? { windowId: p.windowId } : {}) });
  }),
  'tabs.close': route(object({ tabIds }), (p) => tabs.closeTabs(p.tabIds)),
  'tabs.move': route(object({ tabIds, target: union<number | 'new'>(integer, oneOf(['new'] as const)), index: optional(integer) }), (p) =>
    tabs.moveTabs(p.tabIds, p.target, p.index),
  ),
  'tabs.pin': route(object({ tabIds, pinned: boolean }), (p) => tabs.setPinned(p.tabIds, p.pinned)),
  'tabs.mute': route(object({ tabIds, muted: boolean }), (p) => tabs.setMuted(p.tabIds, p.muted)),
  'tabs.sleep': route(object({ tabIds }), (p) => tabs.sleepTabs(p.tabIds)),
  'tabs.reload': route(object({ tabIds }), (p) => tabs.reloadTabs(p.tabIds)),
  'tabs.group': route(object({ tabIds, title: optional(string(100)), color: optional(colorParser), groupId: optional(integer) }), (p) =>
    tabs.groupTabs(p.tabIds, p),
  ),
  'tabs.ungroup': route(object({ tabIds }), (p) => tabs.ungroupTabs(p.tabIds)),
  'tabs.closeDuplicates': route(object({ windowId: optional(integer) }), (p) => tabs.closeDuplicates(p.windowId)),
  'tabs.closeStale': route(none, () => tabs.closeStale()),
  'tabs.sleepInactive': route(none, () => tabs.sleepInactive(0)),
  'tabs.organize': route(object({ windowId: optional(integer) }), (p) => tabs.organizeByDomain(p.windowId)),
  'tabs.sort': route(object({ windowId: integer, by: oneOf(['domain', 'title', 'recent'] as const) }), (p) => tabs.sortWindow(p.windowId, p.by)),
  'tabs.mergeWindows': route(none, () => tabs.mergeWindows()),
  'tabs.reopenClosed': route(object({ sessionId: nonEmpty(200) }), (p) => tabs.reopenClosed(p.sessionId)),
  'tabs.previous': route(none, () => tabs.jumpToPreviousTab()),
  'undo.run': route(object({ undoId: id }), (p) => tabs.runUndo(p.undoId)),
  'dashboard.open': route(object({ hash: optional(string(100)) }), (p) => tabs.openDashboard(p.hash)),

  // ---- workspaces ----
  'workspace.create': route(
    object({
      name: nonEmpty(120),
      color: optional(colorParser),
      icon: optional(iconParser),
      fromWindowId: optional(integer),
      tabIds: optional(tabIds),
      links: optional(array(object({ url: urlParser, title: string(1000) }), 500)),
      bind: optional(boolean),
    }),
    (p) => ws.createWorkspace(p),
  ),
  'workspace.update': route(
    object({ id, name: optional(nonEmpty(120)), color: optional(colorParser), icon: optional(iconParser), autoSync: optional(boolean) }),
    ({ id: wsId, ...patch }) => ws.updateWorkspace(wsId, patch),
  ),
  'workspace.delete': route(object({ id }), (p) => ws.deleteWorkspace(p.id)),
  'workspace.undelete': route(object({ id }), (p) => ws.restoreWorkspaceFromTrash(p.id)),
  'workspace.purge': route(object({ id }), (p) => ws.purgeWorkspace(p.id)),
  'workspace.addTabs': route(object({ id, tabIds, close: optional(boolean) }), (p) => ws.addTabsToWorkspace(p.id, p.tabIds, { close: p.close })),
  'workspace.addLink': route(object({ id, url: urlParser, title: string(1000) }), (p) => ws.addLinkToWorkspace(p.id, p.url, p.title)),
  'workspace.removeItems': route(object({ id, itemIds: ids }), (p) => ws.removeWorkspaceItems(p.id, p.itemIds)),
  'workspace.reorderItems': route(object({ id, itemIds: ids }), (p) => ws.reorderWorkspaceItems(p.id, p.itemIds)),
  'workspace.moveItems': route(object({ from: id, to: id, itemIds: ids }), (p) => ws.moveWorkspaceItems(p.from, p.to, p.itemIds)),
  'workspace.reorder': route(object({ ids }), (p) => ws.reorderWorkspaces(p.ids)),
  'workspace.open': route(object({ id, mode: optional(workspaceMode), windowId: optional(integer), itemIds: optional(ids) }), (p) => ws.openWorkspace(p.id, p)),
  'workspace.saveFromWindow': route(object({ id, windowId: integer }), (p) => ws.saveWorkspaceFromWindow(p.id, p.windowId)),
  'workspace.bind': route(object({ windowId: integer, id: optional(id) }), (p) => ws.bindWorkspace(p.windowId, p.id ?? null)),
  'workspace.closeWindow': route(object({ id }), (p) => ws.closeWorkspaceWindow(p.id)),

  // ---- sessions ----
  'session.save': route(
    object({
      scope: oneOf(['all', 'window', 'tabs'] as const),
      windowId: optional(integer),
      tabIds: optional(tabIds),
      name: optional(string(200)),
      close: optional(boolean),
    }),
    (p) => {
      if (p.scope === 'window') {
        if (p.windowId === undefined) throw new Error('windowId required');
        return sessions.saveCurrent({ scope: 'window', windowId: p.windowId, name: p.name, close: p.close });
      }
      if (p.scope === 'tabs') {
        if (!p.tabIds) throw new Error('tabIds required');
        return sessions.saveCurrent({ scope: 'tabs', tabIds: p.tabIds, name: p.name, close: p.close });
      }
      return sessions.saveCurrent({ scope: 'all', name: p.name, close: p.close });
    },
  ),
  'session.get': route(object({ id }), (p) => sessions.getSession(p.id)),
  'session.patch': route(object({ id, name: optional(nonEmpty(200)), keep: optional(boolean) }), ({ id: sid, ...patch }) => sessions.patchSession(sid, patch)),
  'session.updateFromCurrent': route(object({ id, windowId: optional(integer) }), (p) => sessions.updateSessionFromCurrent(p.id, p.windowId)),
  'session.removeTabs': route(object({ id, tabIds: ids }), (p) => sessions.removeSessionTabs(p.id, p.tabIds)),
  'session.delete': route(object({ id }), (p) => sessions.softDeleteSession(p.id)),
  'session.undelete': route(object({ id }), (p) => sessions.restoreSessionFromTrash(p.id)),
  'session.purge': route(object({ id }), (p) => sessions.purgeSession(p.id)),
  'session.restore': route(
    object({ id, mode: oneOf(['new-windows', 'current-window'] as const), windowId: optional(integer), tabIds: optional(ids) }),
    (p) => sessions.restoreSession(p.id, p),
  ),
  'session.toWorkspace': route(object({ id, name: nonEmpty(120) }), (p) => sessions.sessionToWorkspace(p.id, p.name)),
  'session.snapshotNow': route(none, async () => sessions.takeSnapshot(await captureAll())),
  'recovery.restore': route(none, () => sessions.applyRecovery()),
  'recovery.dismiss': route(none, () => sessions.dismissRecovery()),
  'recovery.check': route(none, () => sessions.checkForRecovery()),

  // ---- later ----
  'later.addTabs': route(object({ tabIds, close: optional(boolean), snoozeUntil: optional(number) }), (p) =>
    later.addTabsToLater(p.tabIds, { close: p.close, snoozeUntil: p.snoozeUntil }),
  ),
  'later.addLink': route(object({ url: urlParser, title: string(1000), snoozeUntil: optional(number) }), (p) =>
    later.addToLater([{ url: p.url, title: p.title }], p.snoozeUntil),
  ),
  'later.open': route(object({ id, active: optional(boolean), keep: optional(boolean) }), (p) => later.openLater(p.id, p)),
  'later.snooze': route(object({ id, until: number }), (p) => later.snoozeLater(p.id, p.until)),
  'later.setState': route(object({ id, state: oneOf(['queued', 'done'] as const) }), (p) => later.setLaterState(p.id, p.state)),
  'later.remove': route(object({ ids }), (p) => later.removeLater(p.ids)),

  // ---- notes ----
  'note.set': route(object({ url: nonEmpty(8192), text: string(5000) }), (p) => setNote(p.url, p.text)),

  // ---- rules ----
  'rule.save': route(
    object({ id: optional(id), name: optional(string(200)), enabled: optional(boolean), match: ruleMatchParser, action: ruleActionParser }),
    (p) => rules.saveRule(p),
  ),
  'rule.delete': route(object({ id }), (p) => rules.deleteRule(p.id)),
  'rule.applyNow': route(none, () => rules.applyRulesToAll()),

  // ---- data ----
  'data.export': route(none, () => backup.exportBackup()),
  'data.import': route(object({ json: string(256 * 1024 * 1024) }), (p) => backup.importBackup(p.json)),
  'data.importLinks': route(object({ text: string(16 * 1024 * 1024), name: optional(string(200)) }), (p) => backup.importLinks(p.text, p.name)),
  'data.clearActivity': route(none, async () => {
    await clearActivity();
    broadcast('activity');
  }),
  'data.wipe': route(none, async () => {
    await backup.wipeEverything();
    await refreshBadge();
  }),
};

export type Handlers = typeof handlers;
export type Method = keyof Handlers;

export interface RpcRequest {
  kind: 'rpc';
  method: string;
  params: unknown;
}

export type RpcResponse = { ok: true; data: unknown } | { ok: false; error: string };

export async function dispatch(request: RpcRequest): Promise<RpcResponse> {
  if (!Object.prototype.hasOwnProperty.call(handlers, request.method)) {
    return { ok: false, error: `Unknown method: ${request.method}` };
  }
  const handler = handlers[request.method as Method] as { params: Parser<unknown>; run: (p: unknown) => Promise<unknown> };
  try {
    const data = await handler.run(handler.params(request.params ?? {}));
    return { ok: true, data: data ?? null };
  } catch (err) {
    console.warn(`[TabVault] ${request.method} failed`, err);
    return { ok: false, error: (err as Error).message || 'Something went wrong.' };
  }
}
