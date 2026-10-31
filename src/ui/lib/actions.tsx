// What you can do to each kind of thing. Shared by the palette's action panel and
// the commands list, so the same operation behaves the same everywhere.

import {
  AppWindow, ArchiveRestore, BedDouble, Copy, ExternalLink, Layers, ListPlus, MoonStar, NotebookPen, Pin, PinOff, PlusSquare, RefreshCw,
  Replace, RotateCcw, Save, Trash2, Volume2, VolumeX, X, Clock, CheckCheck, FolderSymlink,
} from 'lucide-react';
import type { Workspace } from '../../shared/types';
import { snoozeOptions } from '../../shared/time';
import type { MenuItem } from '../components/common';
import type { Dialogs, ToastApi } from '../components/feedback';
import type { DocRef } from './docs';
import { tabUrl } from './hooks';
import { rpc } from './rpc';

export interface ActionContext {
  toast: ToastApi;
  dialogs: Dialogs;
  windowId: number | undefined;
  workspaces: Workspace[];
  /** windowId → workspaceId, to know which workspace a tab is already part of. */
  bindings?: Record<string, string>;
  annotationFor: (url: string) => string | undefined;
  /** Called after an action that sends the user elsewhere (popup closes itself). */
  done: () => void;
}

export type Action = MenuItem & { primary?: boolean };

const iconSize = 15;

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export async function closeWithUndo(ctx: ActionContext, tabIds: number[]): Promise<void> {
  const result = await ctx.toast.guard(rpc('tabs.close', { tabIds }));
  if (!result?.closed) return;
  const undoId = result.undoId;
  ctx.toast.ok(`Closed ${plural(result.closed, 'tab')}`, undoId ? { label: 'Undo', run: () => rpc('undo.run', { undoId }) } : undefined);
}

export function reportAdded(toast: ToastApi, result: { added: number; moved: number; already: number } | undefined, name: string): void {
  if (!result) return;
  if (result.moved) toast.ok(`Moved ${plural(result.moved, 'tab')} to ${name}’s window`);
  else if (result.added) toast.ok(`Added ${plural(result.added, 'tab')} to ${name}`);
  else if (result.already) toast.info(`Already in ${name}`);
  else toast.info('This page can’t be saved.');
}

export async function openWorkspaceWithFeedback(ctx: ActionContext, workspace: Workspace, mode?: 'new-window' | 'replace' | 'append'): Promise<void> {
  const result = await ctx.toast.guard(rpc('workspace.open', { id: workspace.id, mode, windowId: ctx.windowId }));
  if (!result) return;
  if (result.parkedCount) {
    const session = result.parkedSessionId!;
    ctx.toast.ok(`Switched to ${workspace.name}. Parked ${plural(result.parkedCount, 'tab')} in the Vault.`, {
      label: 'Open Vault',
      run: () => rpc('dashboard.open', { hash: `/vault/${session}` }),
    });
  } else if (result.skipped.length) {
    ctx.toast.info(`Opened ${plural(result.opened, 'tab')}. ${plural(result.skipped.length, 'address')} could not be opened.`);
  }
  ctx.done();
}

export async function editNote(ctx: ActionContext, url: string): Promise<void> {
  const current = ctx.annotationFor(url) ?? '';
  const text = await ctx.dialogs.prompt({
    title: 'Why is this open?',
    label: 'A note to your future self. Searchable with note:',
    initial: current,
    multiline: true,
    placeholder: 'e.g. Compare pricing before Friday',
    allowEmpty: true,
    confirm: 'Save note',
  });
  if (text === null) return;
  await ctx.toast.guard(rpc('note.set', { url, text }));
}

function workspaceTargets(ctx: ActionContext, tab: chrome.tabs.Tab, run: (ws: Workspace) => void): Action[] {
  const own = ctx.bindings?.[String(tab.windowId)];
  return ctx.workspaces.slice(0, 8).map((ws) => ({
    id: `to-ws-${ws.id}`,
    label: ws.id === own ? `Already in ${ws.name}` : `Add to ${ws.name}`,
    icon: <FolderSymlink size={iconSize} />,
    disabled: ws.id === own,
    run: () => run(ws),
  }));
}

export function actionsFor(ref: DocRef, ctx: ActionContext): Action[] {
  const { toast } = ctx;
  switch (ref.type) {
    case 'tab': {
      const { tab } = ref;
      const id = tab.id!;
      const url = tabUrl(tab);
      const isCurrent = !!tab.active && tab.windowId === ctx.windowId;
      return [
        { id: 'focus', label: isCurrent ? 'Stay on this tab' : 'Switch to tab', icon: <ExternalLink size={iconSize} />, hint: '↵', primary: true, run: () => void rpc('tabs.focus', { tabId: id }).then(ctx.done, (e: Error) => toast.error(e.message)) },
        { id: 'close', label: 'Close tab', icon: <X size={iconSize} />, hint: 'Del', run: () => void closeWithUndo(ctx, [id]) },
        {
          id: 'later', label: 'Send to Later', icon: <ListPlus size={iconSize} />,
          run: () => void toast.guard(rpc('later.addTabs', { tabIds: [id], close: true })).then((r) => {
            if (r?.added) toast.ok('Saved to Later');
            else if (r) toast.info('This page can’t be saved.');
          }),
        },
        ...workspaceTargets(ctx, tab, (ws) => void toast.guard(rpc('workspace.addTabs', { id: ws.id, tabIds: [id] })).then((r) => reportAdded(toast, r, ws.name))),
        ...snoozeOptions().slice(0, 2).map<Action>((o) => ({
          id: `snooze-${o.id}`, label: `Snooze: ${o.label}`, icon: <Clock size={iconSize} />,
          run: () => void toast.guard(rpc('later.addTabs', { tabIds: [id], close: true, snoozeUntil: o.at })).then((r) => {
            if (r?.added) toast.ok(`Snoozed until ${new Date(o.at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`);
          }),
        })),
        { id: 'note', label: 'Add a note…', icon: <NotebookPen size={iconSize} />, run: () => void editNote(ctx, url) },
        tab.pinned
          ? { id: 'unpin', label: 'Unpin', icon: <PinOff size={iconSize} />, run: () => void toast.guard(rpc('tabs.pin', { tabIds: [id], pinned: false })) }
          : { id: 'pin', label: 'Pin', icon: <Pin size={iconSize} />, run: () => void toast.guard(rpc('tabs.pin', { tabIds: [id], pinned: true })) },
        { id: 'sleep', label: 'Put to sleep', icon: <MoonStar size={iconSize} />, disabled: !!tab.active || !!tab.discarded, run: () => void toast.guard(rpc('tabs.sleep', { tabIds: [id] })) },
        tab.mutedInfo?.muted
          ? { id: 'unmute', label: 'Unmute', icon: <Volume2 size={iconSize} />, run: () => void toast.guard(rpc('tabs.mute', { tabIds: [id], muted: false })) }
          : { id: 'mute', label: 'Mute', icon: <VolumeX size={iconSize} />, run: () => void toast.guard(rpc('tabs.mute', { tabIds: [id], muted: true })) },
        { id: 'new-window', label: 'Move to new window', icon: <AppWindow size={iconSize} />, run: () => void toast.guard(rpc('tabs.move', { tabIds: [id], target: 'new' })) },
        { id: 'copy', label: 'Copy link', icon: <Copy size={iconSize} />, run: () => void navigator.clipboard.writeText(url).then(() => toast.ok('Link copied')) },
      ];
    }
    case 'workspace': {
      const { workspace } = ref;
      return [
        { id: 'open', label: 'Open workspace', icon: <Layers size={iconSize} />, hint: '↵', primary: true, run: () => void openWorkspaceWithFeedback(ctx, workspace) },
        { id: 'new', label: 'Open in new window', icon: <AppWindow size={iconSize} />, run: () => void openWorkspaceWithFeedback(ctx, workspace, 'new-window') },
        { id: 'switch', label: 'Switch this window to it', icon: <Replace size={iconSize} />, run: () => void openWorkspaceWithFeedback(ctx, workspace, 'replace') },
        { id: 'append', label: 'Add its tabs to this window', icon: <PlusSquare size={iconSize} />, run: () => void openWorkspaceWithFeedback(ctx, workspace, 'append') },
        { id: 'manage', label: 'Manage in dashboard', icon: <ExternalLink size={iconSize} />, run: () => void rpc('dashboard.open', { hash: `/workspaces/${workspace.id}` }).then(ctx.done) },
      ];
    }
    case 'workspace-item': {
      const { item, workspace } = ref;
      return [
        { id: 'open', label: 'Open tab', icon: <ExternalLink size={iconSize} />, hint: '↵', primary: true, run: () => void toast.guard(rpc('tabs.open', { url: item.url })).then(ctx.done) },
        { id: 'open-ws', label: `Open all of ${workspace.name}`, icon: <Layers size={iconSize} />, run: () => void openWorkspaceWithFeedback(ctx, workspace) },
        { id: 'note', label: 'Add a note…', icon: <NotebookPen size={iconSize} />, run: () => void editNote(ctx, item.url) },
        { id: 'copy', label: 'Copy link', icon: <Copy size={iconSize} />, run: () => void navigator.clipboard.writeText(item.url).then(() => toast.ok('Link copied')) },
      ];
    }
    case 'session': {
      const { session } = ref;
      return [
        {
          id: 'restore', label: 'Restore session', icon: <ArchiveRestore size={iconSize} />, hint: '↵', primary: true,
          run: () => void toast.guard(rpc('session.restore', { id: session.id, mode: 'new-windows' })).then(ctx.done),
        },
        { id: 'here', label: 'Restore into this window', icon: <PlusSquare size={iconSize} />, run: () => void toast.guard(rpc('session.restore', { id: session.id, mode: 'current-window', windowId: ctx.windowId })).then(ctx.done) },
        { id: 'preview', label: 'Preview in dashboard', icon: <ExternalLink size={iconSize} />, run: () => void rpc('dashboard.open', { hash: `/vault/${session.id}` }).then(ctx.done) },
      ];
    }
    case 'session-tab':
      return savedUrlActions(ctx, ref.url, ref.session ? { label: 'Show its session', hash: `/vault/${ref.session.id}` } : undefined);
    case 'timeline':
      return savedUrlActions(ctx, ref.entry.url, { label: 'Show that snapshot', hash: `/vault/${ref.entry.sessionId}` });
    case 'later': {
      const { item } = ref;
      return [
        { id: 'open', label: 'Open and mark done', icon: <ExternalLink size={iconSize} />, hint: '↵', primary: true, run: () => void toast.guard(rpc('later.open', { id: item.id })).then(ctx.done) },
        { id: 'keep', label: 'Open and keep in queue', icon: <RefreshCw size={iconSize} />, run: () => void toast.guard(rpc('later.open', { id: item.id, keep: true })).then(ctx.done) },
        ...snoozeOptions().map<Action>((o) => ({ id: `snooze-${o.id}`, label: `Snooze: ${o.label}`, icon: <Clock size={iconSize} />, run: () => void toast.guard(rpc('later.snooze', { id: item.id, until: o.at })) })),
        { id: 'done', label: 'Mark done', icon: <CheckCheck size={iconSize} />, run: () => void toast.guard(rpc('later.setState', { id: item.id, state: 'done' })) },
        { id: 'remove', label: 'Remove', icon: <Trash2 size={iconSize} />, danger: true, run: () => void toast.guard(rpc('later.remove', { ids: [item.id] })) },
      ];
    }
    case 'closed':
      return [
        { id: 'reopen', label: ref.entry.kind === 'window' ? 'Reopen window' : 'Reopen tab', icon: <RotateCcw size={iconSize} />, hint: '↵', primary: true, run: () => void toast.guard(rpc('tabs.reopenClosed', { sessionId: ref.entry.sessionId })).then(ctx.done) },
      ];
    case 'command':
      return [
        { id: 'run', label: ref.command.title, icon: <Save size={iconSize} />, hint: '↵', primary: true, run: () => void Promise.resolve(ref.command.run()).catch((e: Error) => toast.error(e.message)) },
      ];
  }
}

function savedUrlActions(ctx: ActionContext, url: string, show?: { label: string; hash: string }): Action[] {
  const { toast } = ctx;
  return [
    { id: 'open', label: 'Open tab', icon: <ExternalLink size={iconSize} />, hint: '↵', primary: true, run: () => void toast.guard(rpc('tabs.open', { url })).then(ctx.done) },
    { id: 'later', label: 'Save to Later', icon: <ListPlus size={iconSize} />, run: () => void toast.guard(rpc('later.addLink', { url, title: url })).then(() => toast.ok('Saved to Later')) },
    { id: 'note', label: 'Add a note…', icon: <NotebookPen size={iconSize} />, run: () => void editNote(ctx, url) },
    { id: 'copy', label: 'Copy link', icon: <Copy size={iconSize} />, run: () => void navigator.clipboard.writeText(url).then(() => toast.ok('Link copied')) },
    ...(show ? [{ id: 'show', label: show.label, icon: <BedDouble size={iconSize} />, run: () => void rpc('dashboard.open', { hash: show.hash }).then(ctx.done) }] : []),
  ];
}

export interface CommandContext extends ActionContext {
  activeTab?: chrome.tabs.Tab;
  surface: 'popup' | 'panel' | 'modal';
  toggleTheme: () => void;
}

/** Everything reachable by typing ">" in the palette. */
export function buildCommands(ctx: CommandContext) {
  const { toast, dialogs, windowId, activeTab } = ctx;
  const notify = (message: string) => toast.ok(message);
  return [
    {
      id: 'save-all', icon: 'save', title: 'Save all windows to the Vault', keywords: 'session snapshot backup store everything',
      run: async () => {
        const name = await dialogs.prompt({ title: 'Save session', label: 'Name (leave blank to name it automatically)', allowEmpty: true, placeholder: 'e.g. Thesis research' });
        if (name === null) return;
        const s = await toast.guard(rpc('session.save', { scope: 'all', name }));
        if (s) notify(`Saved ${plural(s.tabCount, 'tab')} as “${s.name}”`);
      },
    },
    {
      id: 'vault-window', icon: 'archive', title: 'Vault this window and close its tabs', keywords: 'stash park clear clean onetab save close',
      run: async () => {
        if (windowId === undefined) return;
        const s = await toast.guard(rpc('session.save', { scope: 'window', windowId, close: true }));
        if (s) toast.ok(`Vaulted ${plural(s.tabCount, 'tab')}`, { label: 'Restore', run: () => rpc('session.restore', { id: s.id, mode: 'current-window', windowId }) });
      },
    },
    {
      id: 'new-workspace', icon: 'layers', title: 'Make this window a workspace', keywords: 'create new workspace bind live',
      run: async () => {
        if (windowId === undefined) return;
        const name = await dialogs.prompt({ title: 'New workspace from this window', label: 'Name', placeholder: 'e.g. Interview prep', confirm: 'Create' });
        if (!name) return;
        const ws = await toast.guard(rpc('workspace.create', { name, fromWindowId: windowId, bind: true }));
        if (ws) notify(`“${ws.name}” is live in this window and saves itself`);
      },
    },
    {
      id: 'dedupe', icon: 'copy', title: 'Close duplicate tabs', keywords: 'duplicates dedupe clean clutter',
      run: async () => {
        const r = await toast.guard(rpc('tabs.closeDuplicates', {}));
        if (!r) return;
        if (!r.closed) notify('No duplicate tabs. Nice.');
        else toast.ok(`Closed ${plural(r.closed, 'duplicate')}`, r.undoId ? { label: 'Undo', run: () => rpc('undo.run', { undoId: r.undoId! }) } : undefined);
      },
    },
    {
      id: 'stale', icon: 'clock', title: 'Close stale tabs', keywords: 'old inactive unused clean clutter',
      run: async () => {
        const r = await toast.guard(rpc('tabs.closeStale', {}));
        if (!r) return;
        if (!r.closed) notify('Nothing stale right now.');
        else toast.ok(`Closed ${plural(r.closed, 'stale tab')}`, r.undoId ? { label: 'Undo', run: () => rpc('undo.run', { undoId: r.undoId! }) } : undefined);
      },
    },
    {
      id: 'organize', icon: 'group', title: 'Group this window’s tabs by site', keywords: 'organize tidy tab groups domain sort',
      run: async () => {
        const r = await toast.guard(rpc('tabs.organize', { windowId }));
        if (r) notify(r.groups ? `Made ${plural(r.groups, 'group')} from ${plural(r.tabs, 'tab')}` : 'Nothing to group: no site has two loose tabs.');
      },
    },
    {
      id: 'sort', icon: 'sort', title: 'Sort this window’s tabs by site', keywords: 'order arrange domain',
      run: async () => {
        if (windowId === undefined) return;
        await toast.guard(rpc('tabs.sort', { windowId, by: 'domain' }));
        notify('Sorted by site');
      },
    },
    {
      id: 'merge', icon: 'merge', title: 'Merge all windows into this one', keywords: 'combine consolidate windows',
      run: async () => {
        const n = await toast.guard(rpc('tabs.mergeWindows', {}));
        if (n !== undefined) notify(n ? `Moved ${plural(n, 'tab')} here` : 'Only one window open.');
      },
    },
    {
      id: 'sleep', icon: 'moon', title: 'Put inactive tabs to sleep', keywords: 'discard suspend memory free ram',
      run: async () => {
        const n = await toast.guard(rpc('tabs.sleepInactive', {}));
        if (n !== undefined) notify(n ? `${plural(n, 'tab')} now asleep` : 'Nothing to put to sleep.');
      },
    },
    ...(activeTab?.id !== undefined
      ? [{
          id: 'later-current', icon: 'list', title: 'Send this tab to Later', keywords: 'read queue save close',
          run: async () => {
            const r = await toast.guard(rpc('later.addTabs', { tabIds: [activeTab.id!], close: true }));
            if (r?.added) notify('Saved to Later');
            else if (r) toast.info('This page can’t be saved.');
          },
        }]
      : []),
    {
      id: 'dashboard', icon: 'external', title: 'Open dashboard', keywords: 'manage home settings',
      run: () => rpc('dashboard.open', {}).then(ctx.done),
    },
    ...(ctx.surface === 'popup' && windowId !== undefined
      ? [{
          id: 'panel', icon: 'panel', title: 'Open side panel', keywords: 'vertical tabs sidebar',
          // Must stay synchronous with the keypress: sidePanel.open needs a user gesture.
          run: () => {
            void chrome.sidePanel.open({ windowId }).then(ctx.done);
          },
        }]
      : []),
    {
      id: 'theme', icon: 'theme', title: 'Toggle light or dark theme', keywords: 'appearance colour color mode',
      run: () => ctx.toggleTheme(),
    },
    {
      id: 'settings', icon: 'settings', title: 'Open settings', keywords: 'preferences options import export backup privacy',
      run: () => rpc('dashboard.open', { hash: '/settings' }).then(ctx.done),
    },
    {
      id: 'new-ws-empty', icon: 'folder', title: 'Create an empty workspace', keywords: 'new workspace template',
      run: () => rpc('dashboard.open', { hash: '/workspaces/new' }).then(ctx.done),
    },
  ];
}

