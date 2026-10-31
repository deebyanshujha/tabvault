import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  AppWindow, Archive, ArchiveRestore, ArrowLeftRight, Clock, Copy, ExternalLink, FolderPlus, Group, History, HelpCircle, Layers, ListPlus, ListTree, MoonStar,
  MoreHorizontal, NotebookPen, PanelRight, Pin, Plus, RotateCcw, Save, Search, Settings, SunMoon, Volume2, VolumeX, X, Maximize2, type LucideIcon,
} from 'lucide-react';
import { parseQuery, search, SEARCH_HELP, type DocKind } from '../../shared/search';
import { domainOf, displayUrl, isNewTabUrl, urlKey } from '../../shared/urls';
import { timeAgo, timeUntil } from '../../shared/time';
import { ContextMenu, Favicon, IconButton, Kbd, MenuList, VirtualList, WorkspaceBadge, colorVar, type VirtualListHandle } from '../components/common';
import { useDialogs, useToast } from '../components/feedback';
import { actionsFor, buildCommands, closeWithUndo, openWorkspaceWithFeedback, plural, type ActionContext } from '../lib/actions';
import { annotationMap, buildDocs, type ClosedEntry, type DocRef, type PaletteDoc } from '../lib/docs';
import { lastAccessed, useDebounced, useLiveTabs, usePrefs, useVault } from '../lib/hooks';
import { rpc } from '../lib/rpc';

type Surface = 'popup' | 'panel' | 'modal';
type ScopeId = 'all' | 'tabs' | 'workspaces' | 'vault' | 'later';

const SCOPES: { id: ScopeId; label: string; kinds: DocKind[] | null }[] = [
  { id: 'all', label: 'All', kinds: null },
  { id: 'tabs', label: 'Tabs', kinds: ['tab'] },
  { id: 'workspaces', label: 'Workspaces', kinds: ['workspace', 'workspace-item'] },
  { id: 'vault', label: 'Vault', kinds: ['session', 'session-tab', 'timeline', 'closed'] },
  { id: 'later', label: 'Later', kinds: ['later'] },
];

const COMMAND_ICONS: Record<string, LucideIcon> = {
  save: Save, archive: Archive, layers: Layers, copy: Copy, clock: Clock, group: Group, sort: ListTree, merge: ArrowLeftRight, moon: MoonStar,
  list: ListPlus, external: ExternalLink, panel: PanelRight, theme: SunMoon, settings: Settings, folder: FolderPlus,
};

const KIND_LABEL: Partial<Record<DocKind, string>> = {
  workspace: 'Workspace', 'workspace-item': 'In workspace', session: 'Session', 'session-tab': 'Saved', later: 'Later', timeline: 'Time Machine', closed: 'Closed', command: 'Command',
};

type Row =
  | { kind: 'header'; key: string; label: string; workspaceColor?: string }
  | { kind: 'doc'; key: string; doc: PaletteDoc };

const ROW_H = 46;
const HEADER_H = 30;
const rowHeight = (r: Row) => (r.kind === 'header' ? HEADER_H : ROW_H);
const rowKey = (r: Row) => r.key;

export function Palette({ surface, onClose }: { surface: Surface; onClose?: () => void }) {
  const live = useLiveTabs();
  const { vault, loading, error, reload } = useVault();
  const [prefs, updatePrefs] = usePrefs();
  const toast = useToast();
  const dialogs = useDialogs();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<ScopeId>('all');
  const [cursor, setCursor] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [help, setHelp] = useState(false);
  const [closed, setClosed] = useState<ClosedEntry[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<VirtualListHandle | null>(null);
  const debounced = useDebounced(query, 20);

  useEffect(() => {
    input.current?.focus();
    rpc('tabs.recentlyClosed', {}).then(setClosed, () => undefined);
  }, []);

  const windowId = live.currentWindowId;
  const done = useCallback(() => {
    if (surface === 'popup') window.close();
    else if (surface === 'modal') onClose?.();
  }, [surface, onClose]);

  const notes = useMemo(() => annotationMap(vault.annotations), [vault.annotations]);
  const ctx = useMemo<ActionContext>(
    () => ({
      toast, dialogs, windowId, workspaces: vault.workspaces, bindings: vault.bindings, done,
      annotationFor: (url) => notes.get(urlKey(url))?.note,
    }),
    [toast, dialogs, windowId, vault.workspaces, vault.bindings, done, notes],
  );

  const activeTab = useMemo(() => live.tabs.find((t) => t.active && t.windowId === windowId), [live.tabs, windowId]);
  const commands = useMemo(
    () =>
      buildCommands({
        ...ctx, activeTab, surface,
        toggleTheme: () => updatePrefs({ theme: document.documentElement.dataset.theme === 'light' || (prefs.theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'dark' : 'light' }),
      }),
    [ctx, activeTab, surface, updatePrefs, prefs.theme],
  );

  const docs = useMemo(
    () => buildDocs(live, vault, closed, commands, prefs.staleDays),
    [live, vault, closed, commands, prefs.staleDays],
  );

  const parsed = useMemo(() => parseQuery(debounced), [debounced]);
  const scopeKinds = SCOPES.find((s) => s.id === scope)!.kinds;

  const rows = useMemo<Row[]>(() => {
    const toRows = (items: PaletteDoc[]): Row[] => items.map((doc) => ({ kind: 'doc', key: doc.id, doc }));
    if (parsed.isEmpty) {
      const byKind = (kinds: DocKind[]) => docs.filter((d) => kinds.includes(d.kind));
      if (scope === 'all' || scope === 'tabs') {
        if (surface === 'panel') return windowSections(docs, live.windows, windowId, vault);
        const tabs = byKind(['tab']).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
        const tabOf = (d: PaletteDoc) => (d.ref as { tab: chrome.tabs.Tab }).tab;
        const current = tabs.find((d) => tabOf(d).id === activeTab?.id);
        // Empty new tab pages are still open and searchable, just not "recent" anything.
        const mine = tabs.filter((d) => d !== current && (scope === 'tabs' || !isNewTabUrl(d.url)));
        const queued = scope === 'all' ? byKind(['later']).filter((d) => !d.flags?.includes('snoozed')).slice(0, 3) : [];
        return [
          ...(current ? [{ kind: 'header', key: 'h-current', label: 'Current tab' } as Row, ...toRows([current])] : []),
          ...(queued.length ? [{ kind: 'header', key: 'h-later', label: 'Up next in Later' } as Row, ...toRows(queued)] : []),
          { kind: 'header', key: 'h-recent', label: `Recent tabs · ${live.tabs.length} open` },
          ...toRows(mine),
        ];
      }
      if (scope === 'workspaces') return toRows(byKind(['workspace']));
      if (scope === 'vault') {
        const sessions = byKind(['session']);
        const recent = byKind(['closed']);
        return [
          ...(sessions.length ? [{ kind: 'header', key: 'h-s', label: 'Saved sessions' } as Row, ...toRows(sessions)] : []),
          ...(recent.length ? [{ kind: 'header', key: 'h-c', label: 'Recently closed' } as Row, ...toRows(recent)] : []),
        ];
      }
      return toRows(byKind(['later']));
    }
    const merged = { ...parsed, kinds: parsed.kinds ?? scopeKinds };
    const hits = search(docs, merged).map((h) => h.doc as PaletteDoc);
    // In a broad search, one row per page: real tabs always show, saved copies only once.
    if (parsed.kinds || scope !== 'all') return toRows(hits);
    const seen = new Set<string>();
    return toRows(hits.filter((doc) => {
      if (!doc.url) return true;
      const key = urlKey(doc.url);
      if (doc.kind === 'tab') {
        seen.add(key);
        return true;
      }
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }));
  }, [parsed, docs, scope, scopeKinds, surface, live.tabs.length, live.windows, windowId, vault, activeTab?.id]);

  const docIndexes = useMemo(() => rows.flatMap((r, i) => (r.kind === 'doc' ? [i] : [])), [rows]);

  useEffect(() => {
    setCursor(0);
    list.current?.scrollToIndex(0);
    setPanelOpen(false);
  }, [debounced, scope]);

  const cursorRowIndex = docIndexes[Math.min(cursor, Math.max(0, docIndexes.length - 1))] ?? -1;
  const selected = cursorRowIndex >= 0 ? (rows[cursorRowIndex] as Extract<Row, { kind: 'doc' }>).doc : null;
  const actions = useMemo(() => (selected ? actionsFor(selected.ref, ctx) : []), [selected, ctx]);

  const move = (delta: number) => {
    if (!docIndexes.length) return;
    const next = (Math.min(cursor, docIndexes.length - 1) + delta + docIndexes.length) % docIndexes.length;
    setCursor(next);
    list.current?.scrollToIndex(docIndexes[next]!);
  };

  const runPrimary = (doc: PaletteDoc | null) => {
    if (!doc) return;
    const action = actionsFor(doc.ref, ctx).find((a) => a.primary);
    action?.run();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (panelOpen) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'PageDown':
        e.preventDefault();
        move(8);
        break;
      case 'PageUp':
        e.preventDefault();
        move(-8);
        break;
      case 'Enter':
        e.preventDefault();
        runPrimary(selected);
        break;
      case 'Tab': {
        e.preventDefault();
        const at = SCOPES.findIndex((s) => s.id === scope);
        setScope(SCOPES[(at + (e.shiftKey ? -1 : 1) + SCOPES.length) % SCOPES.length]!.id);
        break;
      }
      case 'k':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (selected) setPanelOpen(true);
        }
        break;
      case 'Delete':
        if (selected?.ref.type === 'tab' && input.current?.selectionStart === query.length) {
          e.preventDefault();
          void closeWithUndo(ctx, [selected.ref.tab.id!]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        if (query) setQuery('');
        else if (scope !== 'all') setScope('all');
        else if (surface === 'popup') window.close();
        else onClose?.();
        break;
    }
  };

  const openDashboard = () => void rpc('dashboard.open', {}).then(done);
  const closePanel = useCallback(() => {
    setPanelOpen(false);
    input.current?.focus();
  }, []);

  const currentWsId = windowId !== undefined ? vault.bindings[String(windowId)] : undefined;
  const showStrip = parsed.isEmpty && scope === 'all';

  const newWorkspace = async () => {
    if (windowId === undefined) return;
    const name = await dialogs.prompt({ title: 'New workspace from this window', label: 'Name', placeholder: 'e.g. Interview prep', confirm: 'Create' });
    if (!name) return;
    const ws = await toast.guard(rpc('workspace.create', { name, fromWindowId: windowId, bind: true }));
    if (ws) toast.ok(`“${ws.name}” is live in this window and saves itself`);
  };

  const noResults = !rows.length && !parsed.isEmpty;

  return (
    <div className={`palette palette-${surface}`} onMouseDown={(e) => e.stopPropagation()}>
      <div className="palette-head">
        <Search size={17} className="faint" aria-hidden />
        <input
          ref={input}
          className="palette-input"
          role="combobox"
          aria-expanded
          aria-controls="palette-results"
          aria-label="Search tabs, workspaces, sessions, or type > for commands"
          placeholder={surface === 'panel' ? 'Search everything…' : 'Search tabs, workspaces, the Vault… or > for commands'}
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <IconButton label="Search syntax" active={help} onClick={() => setHelp((v) => !v)}><HelpCircle size={16} /></IconButton>
        {surface !== 'modal' && <IconButton label="Open dashboard" onClick={openDashboard}><Maximize2 size={15} /></IconButton>}
      </div>

      <div className="scopes" role="tablist" aria-label="Search scope">
        {SCOPES.map((s) => (
          <button key={s.id} role="tab" aria-selected={s.id === scope} className={`scope${s.id === scope ? ' is-on' : ''}`} onClick={() => { setScope(s.id); input.current?.focus(); }}>
            {s.label}
            {s.id === 'tabs' && <span className="scope-count">{live.tabs.length}</span>}
            {s.id === 'later' && vault.later.some((i) => i.state === 'queued') && <span className="scope-count">{vault.later.filter((i) => i.state === 'queued').length}</span>}
          </button>
        ))}
        <span className="spacer" />
        {surface !== 'panel' && <span className="foot-hint faint"><Kbd>Tab</Kbd></span>}
      </div>

      {help && (
        <div className="search-help">
          {SEARCH_HELP.map((h) => (
            <div key={h.op}><code>{h.op}</code> <span className="muted">{h.desc}</span></div>
          ))}
        </div>
      )}

      {error && (
        <div className="banner banner-danger" role="alert">
          <X size={15} />
          <span className="spacer">Couldn’t read your vault: {error}</span>
          <button className="btn btn-sm" onClick={reload}>Retry</button>
        </div>
      )}

      {vault.recovery && parsed.isEmpty && (
        <div className="banner">
          <RotateCcw size={15} />
          <span className="spacer">
            <b>{plural(vault.recovery.missing, 'tab')}</b> from before the restart didn’t come back.
          </span>
          <button className="btn btn-sm btn-primary" onClick={() => void toast.guard(rpc('recovery.restore', {})).then((r) => r && done())}>Restore</button>
          <button className="btn btn-sm btn-ghost" onClick={() => void toast.guard(rpc('recovery.dismiss', {}))}>Dismiss</button>
        </div>
      )}

      {showStrip && (
        <div className="ws-strip" role="group" aria-label="Workspaces">
          {vault.workspaces.map((ws) => {
            const isCurrent = ws.id === currentWsId;
            const isLive = Object.values(vault.bindings).includes(ws.id);
            return (
              <button
                key={ws.id}
                className={`ws-chip${isCurrent ? ' is-current' : ''}`}
                style={{ '--ws': colorVar(ws.color) } as CSSProperties}
                title={isLive ? `${ws.name} is open` : `Open ${ws.name}`}
                onClick={() => void openWorkspaceWithFeedback(ctx, ws)}
              >
                <WorkspaceBadge color={ws.color} icon={ws.icon} size={20} />
                {ws.name}
                {isLive ? <span className="dot dot-live" /> : <span className="ws-chip-count">{ws.items.length}</span>}
              </button>
            );
          })}
          <button className="ws-chip ws-chip-add" onClick={() => void newWorkspace()} title="Make this window a workspace">
            <Plus size={13} /> {vault.workspaces.length ? 'New' : 'Make this window a workspace'}
          </button>
        </div>
      )}

      <div className="palette-body">
        {noResults ? (
          <div className="empty">
            <div className="empty-icon"><Search size={20} /></div>
            <h3>Nothing matches “{query}”</h3>
            <p>Saved sessions and Time Machine are searched too. Try fewer words, or look for a site with <span className="mono">domain:</span></p>
          </div>
        ) : !rows.length && !loading ? (
          <div className="empty">
            <div className="empty-icon"><Layers size={20} /></div>
            <h3>{scope === 'later' ? 'Your queue is empty' : scope === 'workspaces' ? 'No workspaces yet' : scope === 'vault' ? 'The Vault is empty' : 'No other tabs open'}</h3>
            <p>{scope === 'later' ? 'Send a tab here with Alt+Shift+S when you want it out of the way but not gone.' : scope === 'workspaces' ? 'A workspace is a named set of tabs that keeps itself up to date.' : scope === 'vault' ? 'Type > to save your session, or let Time Machine do it for you.' : 'Type > to see what TabVault can do.'}</p>
          </div>
        ) : (
          <VirtualList
            items={rows}
            heightOf={rowHeight}
            keyOf={rowKey}
            handleRef={list}
            role="listbox"
            ariaLabel="Results"
            render={(row, i) =>
              row.kind === 'header' ? (
                <div className="section-row">
                  {row.workspaceColor && <span className="dot" style={{ '--ws': row.workspaceColor } as CSSProperties} />}
                  {row.label}
                </div>
              ) : (
                <ResultRow
                  doc={row.doc}
                  active={i === cursorRowIndex}
                  note={row.doc.url ? notes.get(urlKey(row.doc.url))?.note : undefined}
                  from={row.doc.url ? notes.get(urlKey(row.doc.url))?.fromTitle : undefined}
                  currentWindowId={windowId}
                  windowName={row.doc.ref.type === 'tab' && surface !== 'panel' && row.doc.ref.tab.windowId !== windowId
                    ? vault.workspaces.find((w) => w.id === vault.bindings[String((row.doc.ref as { tab: chrome.tabs.Tab }).tab.windowId)])?.name ?? 'Other window'
                    : undefined}
                  onHover={() => setCursor(docIndexes.indexOf(i))}
                  onRun={() => runPrimary(row.doc)}
                  onMenu={(at) => {
                    setCursor(docIndexes.indexOf(i));
                    setPanelOpen(false);
                    setMenuAt(at);
                  }}
                  onClose={row.doc.ref.type === 'tab' ? () => void closeWithUndo(ctx, [(row.doc.ref as { tab: chrome.tabs.Tab }).tab.id!]) : undefined}
                />
              )
            }
          />
        )}
        {panelOpen && selected && (
          <div className="action-panel">
            <MenuList items={actions} onClose={closePanel} label={`Actions for ${selected.title}`} />
          </div>
        )}
        {menuAt && selected && (
          <ContextMenu
            at={menuAt}
            items={actions}
            label={`Actions for ${selected.title}`}
            onClose={() => {
              setMenuAt(null);
              input.current?.focus();
            }}
          />
        )}
      </div>

      <div className="palette-foot">
        {selected ? (
          <>
            <span className="foot-hint"><Kbd>↵</Kbd> {actions.find((a) => a.primary)?.label}</span>
            <span className="foot-hint"><Kbd>Ctrl</Kbd><Kbd>K</Kbd> Actions</span>
            {selected.ref.type === 'tab' && <span className="foot-hint foot-optional"><Kbd>Del</Kbd> Close</span>}
          </>
        ) : (
          <span className="foot-hint"><Kbd>&gt;</Kbd> Commands</span>
        )}
        <span className="spacer" />
        {selected && (
          <IconButton label="All actions" onClick={() => setPanelOpen((v) => !v)}><MoreHorizontal size={14} /></IconButton>
        )}
      </div>
    </div>
  );
}

function windowSections(docs: PaletteDoc[], windows: chrome.windows.Window[], current: number | undefined, vault: { bindings: Record<string, string>; workspaces: { id: string; name: string; color: string }[] }): Row[] {
  const tabDocs = new Map<number, PaletteDoc>();
  for (const d of docs) if (d.ref.type === 'tab') tabDocs.set(d.ref.tab.id!, d);
  const ordered = [...windows].sort((a, b) => (a.id === current ? -1 : b.id === current ? 1 : 0));
  const out: Row[] = [];
  ordered.forEach((win, n) => {
    const ws = vault.workspaces.find((w) => w.id === vault.bindings[String(win.id)]);
    const count = win.tabs?.length ?? 0;
    out.push({
      kind: 'header',
      key: `w-${win.id}`,
      label: `${ws?.name ?? (win.id === current ? 'This window' : `Window ${n + 1}`)} · ${count}`,
      workspaceColor: ws ? colorVar(ws.color as never) : undefined,
    });
    for (const tab of win.tabs ?? []) {
      const doc = tabDocs.get(tab.id!);
      if (doc) out.push({ kind: 'doc', key: doc.id, doc });
    }
  });
  return out;
}

function iconFor(ref: DocRef) {
  switch (ref.type) {
    case 'workspace':
      return <WorkspaceBadge color={ref.workspace.color} icon={ref.workspace.icon} size={22} />;
    case 'session': {
      const Icon = ref.session.kind === 'recovery' ? RotateCcw : ref.session.kind === 'closed-window' ? History : ArchiveRestore;
      return <Icon size={16} />;
    }
    case 'command': {
      const Icon = COMMAND_ICONS[ref.command.icon] ?? Save;
      return <Icon size={16} />;
    }
    default:
      return null;
  }
}

function subline(doc: PaletteDoc, from: string | undefined): string {
  const { ref } = doc;
  switch (ref.type) {
    case 'workspace':
      return `${plural(ref.workspace.items.length, 'tab')}${ref.workspace.lastOpenedAt ? ` · opened ${timeAgo(ref.workspace.lastOpenedAt)}` : ''}`;
    case 'session':
      return `${plural(ref.session.tabCount, 'tab')} · ${timeAgo(ref.session.createdAt)}${ref.session.topDomains.length ? ` · ${ref.session.topDomains.slice(0, 2).join(', ')}` : ''}`;
    case 'workspace-item':
      return `${ref.workspace.name} · ${domainOf(ref.item.url)}`;
    case 'session-tab':
      return `${ref.session?.name ?? 'Session'} · ${domainOf(ref.url)}`;
    case 'later':
      return ref.item.snoozeUntil ? `Back ${timeUntil(ref.item.snoozeUntil)} · ${domainOf(ref.item.url)}` : `${domainOf(ref.item.url)} · saved ${timeAgo(ref.item.addedAt)}`;
    case 'timeline':
      return `Last seen ${timeAgo(ref.entry.lastSeenAt)} · ${domainOf(ref.entry.url)}`;
    case 'closed':
      return `Closed ${timeAgo(ref.entry.at)} · ${domainOf(ref.entry.url)}`;
    case 'command':
      return ref.command.subtitle ?? '';
    case 'tab':
      return from ? `${displayUrl(doc.url)} · from ${from}` : displayUrl(doc.url);
  }
}

function ResultRow({ doc, active, note, from, currentWindowId, windowName, onHover, onRun, onMenu, onClose }: {
  doc: PaletteDoc; active: boolean; note?: string; from?: string; currentWindowId?: number; windowName?: string; onHover: () => void; onRun: () => void; onMenu: (at: { x: number; y: number }) => void; onClose?: () => void;
}) {
  const { ref } = doc;
  const tab = ref.type === 'tab' ? ref.tab : null;
  const icon = iconFor(ref);
  const label = KIND_LABEL[doc.kind];
  const sub = subline(doc, from);
  return (
    <div
      className={`result${active ? ' is-cursor' : ''}${tab?.discarded ? ' is-asleep' : ''}`}
      role="option"
      aria-selected={active}
      onMouseMove={active ? undefined : onHover}
      onClick={onRun}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <span className="result-icon">{icon ?? <Favicon url={doc.url} />}</span>
      <span className="result-body">
        <div className="result-title">{doc.title}</div>
        {(sub || note) && (
          <div className="result-sub">
            {note && <span className="result-note"><NotebookPen size={11} /><span className="truncate">{note}</span></span>}
            <span className="truncate">{sub}</span>
          </div>
        )}
      </span>
      <span className="result-meta">
        {tab?.pinned && <Pin size={13} className="faint" aria-label="Pinned" />}
        {tab?.audible && (tab.mutedInfo?.muted ? <VolumeX size={13} className="faint" aria-label="Muted" /> : <Volume2 size={13} className="muted" aria-label="Playing audio" />)}
        {tab?.discarded && <MoonStar size={13} className="faint" aria-label="Asleep" />}
        {label && <span className="tag">{label}</span>}
        {windowName && <span className="tag" title="This tab is in another window"><AppWindow size={11} />{windowName}</span>}
        {tab && !(tab.active && tab.windowId === currentWindowId) && lastAccessed(tab) > 0 && <span className="faint result-time" style={{ fontSize: 11.5 }}>{timeAgo(lastAccessed(tab))}</span>}
        {onClose && (
          <span className="result-hover">
            <IconButton label="Close tab" className="is-danger" onClick={(e) => { e.stopPropagation(); onClose(); }}><X size={14} /></IconButton>
          </span>
        )}
      </span>
    </div>
  );
}

