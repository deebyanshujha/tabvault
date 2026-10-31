import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import {
  AppWindow, ArchiveRestore, ArrowDownAZ, FolderSymlink, Group, ListPlus, MoonStar, NotebookPen, Pin, PinOff, Search, SquareStack, Ungroup, Volume2, VolumeX, X,
} from 'lucide-react';
import { parseQuery, prepare, search } from '../../../shared/search';
import { domainOf, displayUrl, urlKey } from '../../../shared/urls';
import { isProtectedByRules } from '../../../shared/rules';
import { DAY, timeAgo } from '../../../shared/time';
import { TAB_COLORS, type TabColor } from '../../../shared/types';
import { ContextMenu, Dropdown, Empty, Favicon, IconButton, Segmented, VirtualList, colorVar, type MenuItem, type VirtualListHandle } from '../../components/common';
import { Dialog, useDialogs, useToast } from '../../components/feedback';
import { actionsFor, closeWithUndo, editNote, plural, reportAdded, type ActionContext } from '../../lib/actions';
import { annotationMap, duplicateIds, tabFlags } from '../../lib/docs';
import { lastAccessed, tabUrl, useDebounced, usePrefs, useVault, type LiveData } from '../../lib/hooks';
import { rpc } from '../../lib/rpc';
import { readDraggedTabs, setDraggedTabs, TAB_DRAG_TYPE } from '../dnd';

type GroupBy = 'window' | 'domain' | 'none';
type SortBy = 'position' | 'recent' | 'title' | 'domain';
type Filter = 'duplicate' | 'stale' | 'asleep' | 'audible' | 'pinned' | 'grouped';

type Row =
  | { kind: 'section'; key: string; label: string; windowId?: number; count: number; tabIds: number[] }
  | { kind: 'tab'; key: string; tab: chrome.tabs.Tab; index: number };

const ROW_H = 36;
const SECTION_H = 34;
const heightOf = (r: Row) => (r.kind === 'section' ? SECTION_H : ROW_H);
const keyOf = (r: Row) => r.key;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'duplicate', label: 'Duplicates' },
  { id: 'stale', label: 'Stale' },
  { id: 'asleep', label: 'Asleep' },
  { id: 'audible', label: 'Playing' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'grouped', label: 'Grouped' },
];

export function TabsView({ live }: { live: LiveData }) {
  const { vault } = useVault();
  const [prefs] = usePrefs();
  const toast = useToast();
  const dialogs = useDialogs();
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query, 30);
  const [groupBy, setGroupBy] = useState<GroupBy>('window');
  const [sortBy, setSortBy] = useState<SortBy>('position');
  const [filter, setFilter] = useState<Filter | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [dropSection, setDropSection] = useState<string | null>(null);
  const [draggingIds, setDraggingIds] = useState<Set<number>>(new Set());
  const [groupDialog, setGroupDialog] = useState(false);
  const listHandle = useRef<VirtualListHandle | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const ctx: ActionContext = useMemo(() => ({
    toast, dialogs, windowId: live.currentWindowId, workspaces: vault.workspaces, bindings: vault.bindings, done: () => undefined,
    annotationFor: (url) => vault.annotations.find((a) => a.urlKey === urlKey(url))?.note,
  }), [toast, dialogs, live.currentWindowId, vault.workspaces, vault.bindings, vault.annotations]);

  const tabs = live.tabs;
  const notes = useMemo(() => annotationMap(vault.annotations), [vault.annotations]);
  const duplicates = useMemo(() => duplicateIds(tabs), [tabs]);
  const staleBefore = Date.now() - prefs.staleDays * DAY;
  const isProtected = useCallback((t: chrome.tabs.Tab) => isProtectedByRules(vault.rules, { url: tabUrl(t), title: t.title }), [vault.rules]);
  const flagsOf = useCallback((t: chrome.tabs.Tab) => tabFlags(t, { duplicates, staleBefore, isProtected }), [duplicates, staleBefore, isProtected]);

  const filterCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const t of tabs) for (const f of flagsOf(t)) out[f] = (out[f] ?? 0) + 1;
    return out;
  }, [tabs, flagsOf]);

  const filtered = useMemo(() => {
    let list = tabs;
    if (filter) list = list.filter((t) => flagsOf(t).includes(filter));
    const parsed = parseQuery(debounced);
    if (!parsed.isEmpty) {
      const byId = new Map(list.map((t) => [`tab:${t.id}`, t]));
      const docs = list.map((t) => {
        const url = tabUrl(t);
        return prepare({
          id: `tab:${t.id}`, kind: 'tab', title: t.title || url, url, domain: domainOf(url), note: notes.get(urlKey(url))?.note,
          at: lastAccessed(t) || undefined, flags: flagsOf(t),
          container: t.groupId >= 0 ? live.groups.get(t.groupId)?.title : undefined,
        });
      });
      return search(docs, { ...parsed, kinds: null }, Date.now(), 100000).map((h) => byId.get(h.doc.id)!);
    }
    return list;
  }, [tabs, filter, debounced, notes, flagsOf, live.groups]);

  const sorted = useMemo(() => {
    if (sortBy === 'position') return filtered;
    const copy = [...filtered];
    if (sortBy === 'recent') copy.sort((a, b) => lastAccessed(b) - lastAccessed(a));
    if (sortBy === 'title') copy.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
    if (sortBy === 'domain') copy.sort((a, b) => domainOf(tabUrl(a)).localeCompare(domainOf(tabUrl(b))) || (a.title ?? '').localeCompare(b.title ?? ''));
    return copy;
  }, [filtered, sortBy]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let index = 0;
    const pushTab = (tab: chrome.tabs.Tab) => out.push({ kind: 'tab', key: `t${tab.id}`, tab, index: index++ });
    if (groupBy === 'none') {
      sorted.forEach(pushTab);
    } else if (groupBy === 'window') {
      live.windows.forEach((win, n) => {
        const inWin = sorted.filter((t) => t.windowId === win.id);
        if (!inWin.length && (debounced || filter)) return;
        const ws = vault.workspaces.find((w) => w.id === vault.bindings[String(win.id)]);
        out.push({
          kind: 'section', key: `w${win.id}`, windowId: win.id, count: inWin.length, tabIds: inWin.map((t) => t.id!),
          label: ws ? ws.name : win.id === live.currentWindowId ? 'This window' : `Window ${n + 1}`,
        });
        inWin.forEach(pushTab);
      });
    } else {
      const byDomain = new Map<string, chrome.tabs.Tab[]>();
      for (const t of sorted) {
        const d = domainOf(tabUrl(t)) || 'other';
        const list = byDomain.get(d);
        if (list) list.push(t);
        else byDomain.set(d, [t]);
      }
      [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([d, list]) => {
        out.push({ kind: 'section', key: `d${d}`, label: d, count: list.length, tabIds: list.map((t) => t.id!) });
        list.forEach(pushTab);
      });
    }
    return out;
  }, [sorted, groupBy, live.windows, live.currentWindowId, vault.workspaces, vault.bindings, debounced, filter]);

  const flatTabs = useMemo(() => rows.flatMap((r) => (r.kind === 'tab' ? [r.tab] : [])), [rows]);
  const rowIndexOfTab = useMemo(() => rows.flatMap((r, i) => (r.kind === 'tab' ? [i] : [])), [rows]);

  // Prune selection when tabs go away.
  useEffect(() => {
    setSelected((prev) => {
      const alive = new Set(tabs.map((t) => t.id!));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [tabs]);

  useEffect(() => {
    if (cursor >= flatTabs.length) setCursor(Math.max(0, flatTabs.length - 1));
  }, [flatTabs.length, cursor]);

  const toggle = (id: number, value?: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (value ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const selectRange = (from: number, to: number) => {
    const [a, b] = from < to ? [from, to] : [to, from];
    setSelected((prev) => {
      const next = new Set(prev);
      for (let i = a; i <= b; i++) {
        const id = flatTabs[i]?.id;
        if (id !== undefined) next.add(id);
      }
      return next;
    });
  };

  const moveCursor = (delta: number, extend: boolean) => {
    if (!flatTabs.length) return;
    const next = Math.max(0, Math.min(flatTabs.length - 1, cursor + delta));
    if (extend) {
      const start = anchor ?? cursor;
      setAnchor(start);
      selectRange(start, next);
    } else {
      setAnchor(null);
    }
    setCursor(next);
    listHandle.current?.scrollToIndex(rowIndexOfTab[next] ?? 0);
  };

  const onListKey = (e: KeyboardEvent) => {
    const tab = flatTabs[cursor];
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault();
        moveCursor(1, e.shiftKey);
        break;
      case 'ArrowUp':
      case 'k':
        e.preventDefault();
        moveCursor(-1, e.shiftKey);
        break;
      case ' ':
        e.preventDefault();
        if (tab?.id !== undefined) toggle(tab.id);
        break;
      case 'Enter':
        e.preventDefault();
        if (tab?.id !== undefined) void toast.guard(rpc('tabs.focus', { tabId: tab.id }));
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        if (selected.size) void bulkClose();
        else if (tab?.id !== undefined) void closeWithUndo(ctx, [tab.id]);
        break;
      case 'a':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          setSelected(new Set(flatTabs.map((t) => t.id!)));
        }
        break;
      case 'Escape':
        if (selected.size) {
          e.preventDefault();
          setSelected(new Set());
        }
        break;
    }
  };

  const ids = [...selected];
  const bulkClose = async () => {
    await closeWithUndo(ctx, ids);
    setSelected(new Set());
  };

  const moveMenu: MenuItem[] = [
    { id: 'new', label: 'New window', icon: <AppWindow size={15} />, run: () => void toast.guard(rpc('tabs.move', { tabIds: ids, target: 'new' })).then(() => setSelected(new Set())) },
    ...live.windows.map((w, n) => ({
      id: `w${w.id}`,
      label: vault.workspaces.find((x) => x.id === vault.bindings[String(w.id)])?.name ?? (w.id === live.currentWindowId ? 'This window' : `Window ${n + 1}`),
      icon: <AppWindow size={15} />,
      run: () => void toast.guard(rpc('tabs.move', { tabIds: ids, target: w.id! })).then(() => setSelected(new Set())),
    })),
  ];

  const workspaceMenu: MenuItem[] = vault.workspaces.length
    ? vault.workspaces.map((ws) => ({
        id: ws.id, label: ws.name, icon: <FolderSymlink size={15} />,
        run: () => void toast.guard(rpc('workspace.addTabs', { id: ws.id, tabIds: ids })).then((r) => {
          reportAdded(toast, r, ws.name);
          setSelected(new Set());
        }),
      }))
    : [{ id: 'none', label: 'No workspaces yet', disabled: true, run: () => undefined }];

  const onRowClick = (e: MouseEvent, tab: chrome.tabs.Tab, position: number) => {
    setCursor(position);
    if (e.shiftKey) {
      selectRange(anchor ?? cursor, position);
      setAnchor(anchor ?? cursor);
    } else if (e.ctrlKey || e.metaKey) {
      toggle(tab.id!);
      setAnchor(position);
    } else {
      void toast.guard(rpc('tabs.focus', { tabId: tab.id! }));
    }
    wrap.current?.focus();
  };

  const dropOnWindow = (e: React.DragEvent, windowId: number) => {
    e.preventDefault();
    setDropSection(null);
    const dragged = readDraggedTabs(e);
    if (dragged.length) void toast.guard(rpc('tabs.move', { tabIds: dragged, target: windowId }));
  };

  return (
    <div className="page-fill" style={{ position: 'relative' }}>
      <div className="toolbar">
        <h1 className="page-title" style={{ marginRight: 8 }}>Open <em>tabs</em></h1>
        <div className="toolbar-search">
          <Search size={14} />
          <input className="input" placeholder="Filter: words, domain:, is:, note:…" aria-label="Filter tabs" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              wrap.current?.focus();
            }
          }} />
        </div>
        <span className="spacer" />
        <Segmented<GroupBy> label="Group by" value={groupBy} onChange={setGroupBy} options={[
          { value: 'window', label: 'Window' }, { value: 'domain', label: 'Site' }, { value: 'none', label: 'Flat' },
        ]} />
        <Dropdown
          label="Sort"
          align="right"
          trigger={(p) => <button className="btn" {...p}><ArrowDownAZ size={14} />{{ position: 'Tab order', recent: 'Recent', title: 'Title', domain: 'Site' }[sortBy]}</button>}
          items={[
            { id: 'position', label: 'Tab order', run: () => setSortBy('position') },
            { id: 'recent', label: 'Recently used', run: () => setSortBy('recent') },
            { id: 'title', label: 'Title', run: () => setSortBy('title') },
            { id: 'domain', label: 'Site', run: () => setSortBy('domain') },
          ]}
        />
        <Dropdown
          label="Window actions"
          align="right"
          trigger={(p) => <button className="btn" {...p}>Tidy</button>}
          items={[
            { id: 'dedupe', label: 'Close duplicates', run: () => void toast.guard(rpc('tabs.closeDuplicates', {})).then((r) => {
              if (r) toast.ok(r.closed ? `Closed ${plural(r.closed, 'duplicate')}` : 'No duplicates', r.undoId ? { label: 'Undo', run: () => rpc('undo.run', { undoId: r.undoId! }) } : undefined);
            }) },
            { id: 'organize', label: 'Group all windows by site', run: () => void toast.guard(rpc('tabs.organize', {})).then((r) => r && toast.ok(r.groups ? `Made ${plural(r.groups, 'group')}` : 'Nothing to group')) },
            { id: 'sort', label: 'Sort this window by site', disabled: live.currentWindowId === undefined, run: () => void toast.guard(rpc('tabs.sort', { windowId: live.currentWindowId!, by: 'domain' })) },
            { id: 'merge', label: 'Merge all windows', run: () => void toast.guard(rpc('tabs.mergeWindows', {})) },
            { id: 'sleep', label: 'Put inactive tabs to sleep', run: () => void toast.guard(rpc('tabs.sleepInactive', {})).then((n) => n !== undefined && toast.ok(n ? `${plural(n, 'tab')} now asleep` : 'Nothing to put to sleep')) },
          ]}
        />
      </div>
      <div className="chips" role="group" aria-label="Quick filters">
        {FILTERS.map((f) => {
          const n = filterCounts[f.id] ?? 0;
          return (
            <button key={f.id} className={`chip${filter === f.id ? ' is-on' : ''}`} aria-pressed={filter === f.id} disabled={!n && filter !== f.id} onClick={() => setFilter(filter === f.id ? null : f.id)}>
              {f.label} <b>{n}</b>
            </button>
          );
        })}
      </div>

      {!rows.length ? (
        <Empty icon={<SquareStack size={20} />} title={debounced || filter ? 'No tabs match' : 'No tabs open'}>
          {debounced || filter ? 'Try removing a filter.' : ''}
        </Empty>
      ) : (
        <div ref={wrap} className="page-fill tabs-list" tabIndex={0} onKeyDown={onListKey} aria-label="Open tabs. Arrow keys move, space selects.">
          <VirtualList
            items={rows}
            heightOf={heightOf}
            keyOf={keyOf}
            handleRef={listHandle}
            ariaLabel="Tabs"
            render={(row) => {
              if (row.kind === 'section') {
                const allSelected = row.tabIds.length > 0 && row.tabIds.every((id) => selected.has(id));
                return (
                  <div
                    className={`tab-section${dropSection === row.key ? ' is-drop' : ''}`}
                    onDragOver={row.windowId !== undefined ? (e) => {
                      if (e.dataTransfer.types.includes(TAB_DRAG_TYPE)) {
                        e.preventDefault();
                        setDropSection(row.key);
                      }
                    } : undefined}
                    onDragLeave={() => setDropSection(null)}
                    onDrop={row.windowId !== undefined ? (e) => dropOnWindow(e, row.windowId!) : undefined}
                  >
                    <input
                      type="checkbox"
                      className="tab-check"
                      aria-label={`Select all in ${row.label}`}
                      checked={allSelected}
                      onChange={(e) => setSelected((prev) => {
                        const next = new Set(prev);
                        for (const id of row.tabIds) {
                          if (e.target.checked) next.add(id);
                          else next.delete(id);
                        }
                        return next;
                      })}
                    />
                    <span className="truncate">{row.label}</span>
                    <span className="faint mono">{row.count}</span>
                  </div>
                );
              }
              return (
                <TabRow
                  tab={row.tab}
                  isCursor={row.index === cursor}
                  isSelected={selected.has(row.tab.id!)}
                  isDragging={draggingIds.has(row.tab.id!)}
                  isDuplicate={duplicates.has(row.tab.id!)}
                  group={row.tab.groupId >= 0 ? live.groups.get(row.tab.groupId) : undefined}
                  note={notes.get(urlKey(tabUrl(row.tab)))?.note}
                  from={notes.get(urlKey(tabUrl(row.tab)))?.fromTitle}
                  onClick={(e) => onRowClick(e, row.tab, row.index)}
                  onToggle={() => toggle(row.tab.id!)}
                  onClose={() => void closeWithUndo(ctx, [row.tab.id!])}
                  onDragStart={(e) => {
                    const dragged = selected.has(row.tab.id!) ? ids : [row.tab.id!];
                    setDraggedTabs(e, dragged);
                    setDraggingIds(new Set(dragged));
                  }}
                  onDragEnd={() => setDraggingIds(new Set())}
                  ctx={ctx}
                />
              );
            }}
          />
        </div>
      )}

      {selected.size > 0 && (
        <div className="bulk" role="toolbar" aria-label="Bulk actions">
          <span className="bulk-count">{selected.size} selected</span>
          <button className="btn btn-sm" onClick={() => void bulkClose()}><X size={14} />Close</button>
          <button className="btn btn-sm" onClick={() => void toast.guard(rpc('later.addTabs', { tabIds: ids, close: true })).then((r) => {
            if (r) toast.ok(`Saved ${plural(r.added, 'tab')} to Later`);
            setSelected(new Set());
          })}><ListPlus size={14} />Later</button>
          <button className="btn btn-sm" onClick={() => void toast.guard(rpc('session.save', { scope: 'tabs', tabIds: ids })).then((s) => {
            if (s) toast.ok(`Saved ${plural(s.tabCount, 'tab')} as “${s.name}”`);
          })}><ArchiveRestore size={14} />Vault</button>
          <button className="btn btn-sm" onClick={() => setGroupDialog(true)}><Group size={14} />Group</button>
          <button className="btn btn-sm" title="Remove from group" onClick={() => void toast.guard(rpc('tabs.ungroup', { tabIds: ids }))}><Ungroup size={14} /></button>
          <Dropdown label="Move to window" trigger={(p) => <button className="btn btn-sm" {...p}><AppWindow size={14} />Move</button>} items={moveMenu} />
          <Dropdown label="Add to workspace" trigger={(p) => <button className="btn btn-sm" {...p}><FolderSymlink size={14} />Workspace</button>} items={workspaceMenu} />
          <button className="btn btn-sm" title="Pin" onClick={() => void toast.guard(rpc('tabs.pin', { tabIds: ids, pinned: true }))}><Pin size={14} /></button>
          <button className="btn btn-sm" title="Unpin" onClick={() => void toast.guard(rpc('tabs.pin', { tabIds: ids, pinned: false }))}><PinOff size={14} /></button>
          <button className="btn btn-sm" title="Put to sleep" onClick={() => void toast.guard(rpc('tabs.sleep', { tabIds: ids })).then((n) => n !== undefined && toast.ok(`${plural(n, 'tab')} asleep`))}><MoonStar size={14} /></button>
          <IconButton label="Clear selection" onClick={() => setSelected(new Set())}><X size={14} /></IconButton>
        </div>
      )}

      {groupDialog && <GroupDialog onClose={() => setGroupDialog(false)} onSubmit={(title, color) => {
        setGroupDialog(false);
        void toast.guard(rpc('tabs.group', { tabIds: ids, title, color })).then((id) => {
          if (id !== undefined) {
            toast.ok(`Grouped ${plural(ids.length, 'tab')}`);
            setSelected(new Set());
          }
        });
      }} />}
    </div>
  );
}

function GroupDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (title: string, color: TabColor) => void }) {
  const [title, setTitle] = useState('');
  const [color, setColor] = useState<TabColor>('blue');
  return (
    <Dialog title="Group tabs" onClose={onClose}>
      <div className="field">
        <label className="field-label" htmlFor="group-name">Name</label>
        <input id="group-name" className="input" data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onSubmit(title, color)} />
      </div>
      <div className="field">
        <span className="field-label">Colour</span>
        <div className="swatches" role="radiogroup" aria-label="Group colour">
          {TAB_COLORS.map((c) => (
            <button key={c} className="swatch" role="radio" aria-checked={c === color} aria-label={c} style={{ '--ws': colorVar(c) } as CSSProperties} onClick={() => setColor(c)} />
          ))}
        </div>
      </div>
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => onSubmit(title, color)}>Group</button>
      </div>
    </Dialog>
  );
}

function TabRow({
  tab, isCursor, isSelected, isDragging, isDuplicate, group, note, from, onClick, onToggle, onClose, onDragStart, onDragEnd, ctx,
}: {
  tab: chrome.tabs.Tab; isCursor: boolean; isSelected: boolean; isDragging: boolean; isDuplicate: boolean; group?: chrome.tabGroups.TabGroup;
  note?: string; from?: string; onClick: (e: MouseEvent) => void; onToggle: () => void; onClose: () => void;
  onDragStart: (e: React.DragEvent) => void; onDragEnd: () => void; ctx: ActionContext;
}) {
  const url = tabUrl(tab);
  const { toast } = ctx;
  const stop = (e: MouseEvent) => e.stopPropagation();
  const last = lastAccessed(tab);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
    <div
      className={`tab-row${isCursor ? ' is-cursor' : ''}${isSelected ? ' is-selected' : ''}${tab.active ? ' is-active' : ''}${isDragging ? ' is-dragging' : ''}${tab.discarded ? ' is-asleep' : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onClick}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
      title={url}
    >
      <input type="checkbox" className="tab-check" tabIndex={-1} aria-label={`Select ${tab.title}`} checked={isSelected} onClick={stop} onChange={onToggle} />
      <Favicon url={url} />
      <div className="tab-body">
        <span className="tab-title">{tab.title || url || 'New Tab'}</span>
        <span className="tab-domain">
          {note ? <span className="result-note"><NotebookPen size={11} />{note}</span> : from ? `from ${from}` : displayUrl(url)}
        </span>
      </div>
      {group && <span className="group-pill" style={{ '--ws': colorVar((group.color as TabColor) ?? 'grey') } as CSSProperties}>{group.title || 'Group'}</span>}
      {isDuplicate && <span className="tag tag-accent">Duplicate</span>}
      {tab.pinned && <Pin size={13} className="faint" aria-label="Pinned" />}
      {tab.discarded && <MoonStar size={13} className="faint" aria-label="Asleep" />}
      {tab.audible && <Volume2 size={13} className="muted" aria-label="Playing audio" />}
      {!tab.active && last > 0 && <span className="faint" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>{timeAgo(last)}</span>}
      <span className="tab-actions" onClick={stop}>
        <IconButton label="Add a note" onClick={() => void editNote(ctx, url)}><NotebookPen size={14} /></IconButton>
        <IconButton label={tab.pinned ? 'Unpin' : 'Pin'} onClick={() => void toast.guard(rpc('tabs.pin', { tabIds: [tab.id!], pinned: !tab.pinned }))}>{tab.pinned ? <PinOff size={14} /> : <Pin size={14} />}</IconButton>
        {tab.audible && <IconButton label={tab.mutedInfo?.muted ? 'Unmute' : 'Mute'} onClick={() => void toast.guard(rpc('tabs.mute', { tabIds: [tab.id!], muted: !tab.mutedInfo?.muted }))}>{tab.mutedInfo?.muted ? <Volume2 size={14} /> : <VolumeX size={14} />}</IconButton>}
        <IconButton label="Put to sleep" disabled={!!tab.active || !!tab.discarded} onClick={() => void toast.guard(rpc('tabs.sleep', { tabIds: [tab.id!] }))}><MoonStar size={14} /></IconButton>
        <IconButton label="Send to Later" onClick={() => void toast.guard(rpc('later.addTabs', { tabIds: [tab.id!], close: true })).then((r) => r?.added && toast.ok('Saved to Later'))}><ListPlus size={14} /></IconButton>
        <IconButton label="Close tab" className="is-danger" onClick={onClose}><X size={14} /></IconButton>
      </span>
    </div>
    {menuAt && <ContextMenu at={menuAt} items={actionsFor({ type: 'tab', tab }, ctx)} label={`Actions for ${tab.title}`} onClose={() => setMenuAt(null)} />}
    </>
  );
}
