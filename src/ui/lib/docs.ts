// Turns everything TabVault knows about into uniform search documents.

import type { Annotation, LaterItem, SavedTab, SessionSummary, TimelineEntry, VaultState, Workspace } from '../../shared/types';
import { prepare, type Prepared, type SearchDoc } from '../../shared/search';
import { domainOf, isNewTabUrl, urlKey } from '../../shared/urls';
import { findDuplicates } from '../../shared/clutter';
import { isProtectedByRules } from '../../shared/rules';
import { DAY } from '../../shared/time';
import { lastAccessed, tabUrl, type LiveData } from './hooks';
import type { ClosedEntry } from '../../background/tabs';

export type { ClosedEntry };

export interface Command {
  id: string;
  title: string;
  subtitle?: string;
  keywords: string;
  icon: string;
  run: () => void | Promise<unknown>;
}

export type DocRef =
  | { type: 'tab'; tab: chrome.tabs.Tab }
  | { type: 'workspace'; workspace: Workspace }
  | { type: 'workspace-item'; workspace: Workspace; item: SavedTab }
  | { type: 'session'; session: SessionSummary }
  | { type: 'session-tab'; session: SessionSummary | undefined; url: string; title: string }
  | { type: 'later'; item: LaterItem }
  | { type: 'timeline'; entry: TimelineEntry }
  | { type: 'closed'; entry: ClosedEntry }
  | { type: 'command'; command: Command };

export type PaletteDoc = Prepared & { ref: DocRef };

const make = (doc: SearchDoc, ref: DocRef): PaletteDoc => ({ ...prepare(doc), ref });

export function annotationMap(annotations: Annotation[]): Map<string, Annotation> {
  return new Map(annotations.map((a) => [a.urlKey, a]));
}

export function clutterShape(tab: chrome.tabs.Tab) {
  return {
    id: tab.id ?? -1,
    windowId: tab.windowId,
    url: tabUrl(tab),
    title: tab.title ?? '',
    pinned: !!tab.pinned,
    active: !!tab.active,
    audible: !!tab.audible,
    lastAccessed: lastAccessed(tab),
  };
}

/** The set of tab ids that are redundant copies. Shared by search flags and the Tabs view. */
export function duplicateIds(tabs: chrome.tabs.Tab[]): Set<number> {
  const out = new Set<number>();
  for (const set of findDuplicates(tabs.map(clutterShape))) {
    out.add(set.keep.id);
    for (const t of set.extras) out.add(t.id);
  }
  return out;
}

export function tabFlags(tab: chrome.tabs.Tab, ctx: { duplicates: Set<number>; staleBefore: number; isProtected: (t: chrome.tabs.Tab) => boolean }): string[] {
  const flags: string[] = [];
  if (tab.pinned) flags.push('pinned');
  if (tab.audible) flags.push('audible');
  if (tab.mutedInfo?.muted) flags.push('muted');
  if (tab.discarded) flags.push('asleep');
  if (tab.groupId >= 0) flags.push('grouped');
  if (tab.active) flags.push('active');
  if (ctx.duplicates.has(tab.id ?? -1)) flags.push('duplicate');
  const last = lastAccessed(tab);
  if (last && last < ctx.staleBefore && !tab.pinned && !ctx.isProtected(tab)) flags.push('stale');
  return flags;
}

export function buildDocs(
  live: LiveData,
  vault: VaultState,
  closed: ClosedEntry[],
  commands: Command[],
  staleDays: number,
): PaletteDoc[] {
  const docs: PaletteDoc[] = [];
  const notes = annotationMap(vault.annotations);
  const duplicates = duplicateIds(live.tabs);
  const staleBefore = Date.now() - staleDays * DAY;
  const isProtected = (t: chrome.tabs.Tab) => isProtectedByRules(vault.rules, { url: tabUrl(t), title: t.title });
  const workspaceNames = new Map(vault.workspaces.map((w) => [w.id, w.name]));

  const openKeys = new Set<string>();
  for (const tab of live.tabs) {
    const url = tabUrl(tab);
    openKeys.add(urlKey(url));
    const key = urlKey(url);
    const ws = workspaceNames.get(vault.bindings[String(tab.windowId)] ?? '');
    const groupTitle = tab.groupId >= 0 ? live.groups.get(tab.groupId)?.title : undefined;
    docs.push(make(
      {
        id: `tab:${tab.id}`,
        kind: 'tab',
        title: tab.title || url || 'New Tab',
        url,
        domain: domainOf(url),
        note: notes.get(key)?.note,
        at: lastAccessed(tab) || undefined,
        flags: tabFlags(tab, { duplicates, staleBefore, isProtected }),
        container: [groupTitle, ws].filter(Boolean).join(' '),
      },
      { type: 'tab', tab },
    ));
  }

  for (const workspace of vault.workspaces) {
    docs.push(make(
      {
        id: `ws:${workspace.id}`,
        kind: 'workspace',
        title: workspace.name,
        url: '',
        domain: '',
        at: workspace.lastOpenedAt ?? workspace.updatedAt,
        keywords: 'workspace',
        flags: vault.bindings && Object.values(vault.bindings).includes(workspace.id) ? ['live'] : [],
      },
      { type: 'workspace', workspace },
    ));
    for (const item of workspace.items) {
      docs.push(make(
        { id: `wsi:${workspace.id}:${item.id}`, kind: 'workspace-item', title: item.title, url: item.url, domain: domainOf(item.url), note: notes.get(urlKey(item.url))?.note, container: workspace.name },
        { type: 'workspace-item', workspace, item },
      ));
    }
  }

  const sessionsById = new Map(vault.sessions.map((s) => [s.id, s]));
  for (const session of vault.sessions) {
    if (session.kind === 'auto') continue;
    docs.push(make(
      { id: `s:${session.id}`, kind: 'session', title: session.name, url: '', domain: '', at: session.createdAt, keywords: `session vault ${session.topDomains.join(' ')}` },
      { type: 'session', session },
    ));
  }
  vault.sessionTabs.forEach((t, i) => {
    const session = sessionsById.get(t.sessionId);
    docs.push(make(
      { id: `st:${t.sessionId}:${i}`, kind: 'session-tab', title: t.title, url: t.url, domain: domainOf(t.url), note: notes.get(urlKey(t.url))?.note, container: session?.name, at: session?.createdAt },
      { type: 'session-tab', session, url: t.url, title: t.title },
    ));
  });

  for (const item of vault.later) {
    if (item.state === 'done') continue;
    docs.push(make(
      { id: `l:${item.id}`, kind: 'later', title: item.title, url: item.url, domain: domainOf(item.url), note: notes.get(urlKey(item.url))?.note, at: item.addedAt, keywords: 'later queue read', flags: item.state === 'snoozed' ? ['snoozed'] : [] },
      { type: 'later', item },
    ));
  }

  for (const entry of closed) {
    if (!entry.url || isNewTabUrl(entry.url)) continue;
    docs.push(make(
      { id: `c:${entry.sessionId}`, kind: 'closed', title: entry.kind === 'window' ? `Window: ${entry.title} (${entry.tabCount} tabs)` : entry.title, url: entry.url, domain: domainOf(entry.url), at: entry.at },
      { type: 'closed', entry },
    ));
  }

  // Time Machine: what you had open, minus what's still open.
  for (const entry of vault.timeline) {
    if (openKeys.has(urlKey(entry.url))) continue;
    docs.push(make(
      { id: `t:${entry.url}`, kind: 'timeline', title: entry.title, url: entry.url, domain: domainOf(entry.url), note: notes.get(urlKey(entry.url))?.note, at: entry.lastSeenAt },
      { type: 'timeline', entry },
    ));
  }

  for (const command of commands) {
    docs.push(make(
      { id: `cmd:${command.id}`, kind: 'command', title: command.title, url: '', domain: '', keywords: command.keywords },
      { type: 'command', command },
    ));
  }
  return docs;
}
