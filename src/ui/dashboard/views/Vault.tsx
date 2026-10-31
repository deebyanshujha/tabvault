import { useEffect, useMemo, useState } from 'react';
import {
  Archive, ArchiveRestore, Bookmark, BookmarkCheck, Camera, ChevronDown, FileText, FolderInput, History, Layers, MoreHorizontal, PlusSquare, RefreshCw, RotateCcw, Save, Trash2, Upload, X, AppWindow,
} from 'lucide-react';
import type { Session, SessionKind, SessionSummary } from '../../../shared/types';
import { displayUrl } from '../../../shared/urls';
import { dayKey, formatDateTime, timeAgo } from '../../../shared/time';
import { toMarkdown } from '../../../shared/importers';
import { Dropdown, Empty, Favicon, IconButton, Segmented } from '../../components/common';
import { useDialogs, useToast } from '../../components/feedback';
import { plural } from '../../lib/actions';
import { useVault, type LiveData } from '../../lib/hooks';
import { rpc } from '../../lib/rpc';

type Filter = 'saved' | 'timeline' | 'closed';

const KIND_ICON: Record<SessionKind, typeof Archive> = {
  manual: Bookmark, auto: Camera, 'closed-window': AppWindow, recovery: RotateCcw, parked: FolderInput, imported: Upload,
};
const KIND_LABEL: Record<SessionKind, string> = {
  manual: 'Saved', auto: 'Snapshot', 'closed-window': 'Closed window', recovery: 'Recovery', parked: 'Parked', imported: 'Imported',
};

function matches(filter: Filter, s: SessionSummary): boolean {
  if (filter === 'timeline') return s.kind === 'auto';
  if (filter === 'closed') return s.kind === 'closed-window';
  return s.kind !== 'auto' && s.kind !== 'closed-window';
}

function dayLabel(ts: number): string {
  const key = dayKey(ts);
  const now = Date.now();
  if (key === dayKey(now)) return 'Today';
  if (key === dayKey(now - 86_400_000)) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export function VaultView({ live, param, go }: { live: LiveData; param?: string; go: (p: string) => void }) {
  const { vault, loading } = useVault();
  const toast = useToast();
  const dialogs = useDialogs();
  const [filter, setFilter] = useState<Filter>('saved');
  const selectedSummary = vault.sessions.find((s) => s.id === param);

  // Deep links (e.g. from a toast) should land on the tab that contains the session.
  useEffect(() => {
    if (selectedSummary) setFilter(selectedSummary.kind === 'auto' ? 'timeline' : selectedSummary.kind === 'closed-window' ? 'closed' : 'saved');
  }, [selectedSummary?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => vault.sessions.filter((s) => matches(filter, s)), [vault.sessions, filter]);
  const groups = useMemo(() => {
    const out: { label: string; items: SessionSummary[] }[] = [];
    for (const s of list) {
      const label = filter === 'saved' && s.keep ? 'Kept' : dayLabel(s.createdAt);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(s);
      else out.push({ label, items: [s] });
    }
    return out;
  }, [list, filter]);

  const saveNow = async () => {
    const name = await dialogs.prompt({ title: 'Save session', label: 'Name (leave blank to name it automatically)', allowEmpty: true, placeholder: 'e.g. Thesis research', confirm: 'Save' });
    if (name === null) return;
    const session = await toast.guard(rpc('session.save', { scope: 'all', name }));
    if (session) {
      toast.ok(`Saved ${plural(session.tabCount, 'tab')}`);
      go(`vault/${session.id}`);
    }
  };

  return (
    <div className="page-fill">
      <div className="toolbar" style={{ paddingBottom: 12 }}>
        <h1 className="page-title" style={{ marginRight: 8 }}>The <em>vault</em></h1>
        <Segmented<Filter> label="Which sessions" value={filter} onChange={setFilter} options={[
          { value: 'saved', label: 'Saved' }, { value: 'timeline', label: <><History size={13} />Time Machine</> }, { value: 'closed', label: 'Closed windows' },
        ]} />
        <span className="spacer" />
        {filter === 'timeline' && (
          <button className="btn" onClick={() => void toast.guard(rpc('session.snapshotNow', {})).then((s) => toast.info(s ? 'Snapshot taken' : 'No changes since the last snapshot'))}><Camera size={14} />Snapshot now</button>
        )}
        <button className="btn btn-primary" onClick={() => void saveNow()}><Save size={14} />Save session</button>
      </div>

      <div className="vault">
        <div className="vault-list" aria-label="Sessions">
          {!list.length && !loading && (
            <Empty
              icon={filter === 'timeline' ? <History size={20} /> : <Archive size={20} />}
              title={filter === 'timeline' ? 'No snapshots yet' : filter === 'closed' ? 'No closed windows' : 'Nothing saved yet'}
            >
              {filter === 'timeline' ? 'Every few minutes, TabVault quietly saves a snapshot when your tabs have changed.' :
                filter === 'closed' ? 'Close a window with two or more tabs and it lands here automatically.' :
                'Save your session to keep it, or park a window here with “Switch here” on a workspace.'}
            </Empty>
          )}
          {groups.map((g) => (
            <div key={g.label}>
              <div className="day-label">{g.label}</div>
              {g.items.map((s) => {
                const Icon = KIND_ICON[s.kind];
                return (
                  <button key={s.id} className={`vault-item${s.id === param ? ' is-on' : ''}`} aria-current={s.id === param ? 'true' : undefined} onClick={() => go(`vault/${s.id}`)}>
                    <Icon size={15} className="vault-item-icon" />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <div className="vault-item-name">{s.name}</div>
                      <div className="vault-item-sub">{plural(s.tabCount, 'tab')} · {s.kind === 'auto' ? new Date(s.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : timeAgo(s.createdAt)}</div>
                    </span>
                    {s.keep && <BookmarkCheck size={13} className="faint" aria-label="Kept" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="vault-preview">
          {selectedSummary ? (
            <SessionPreview key={selectedSummary.id} summary={selectedSummary} live={live} go={go} />
          ) : (
            <Empty icon={<ArchiveRestore size={20} />} title="Pick a session to preview">Look through its tabs, then restore all of them or just the ones you need.</Empty>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionPreview({ summary, live, go }: { summary: SessionSummary; live: LiveData; go: (p: string) => void }) {
  const toast = useToast();
  const dialogs = useDialogs();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    rpc('session.get', { id: summary.id })
      .then((s) => {
        if (!alive) return;
        setSession(s ?? null);
        setError(s ? null : 'This session could not be read.');
      })
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [summary.id, summary.updatedAt]);

  const allTabs = useMemo(() => session?.windows.flatMap((w) => w.tabs) ?? [], [session]);
  const pickedIds = [...picked].filter((id) => allTabs.some((t) => t.id === id));
  const restoreIds = pickedIds.length ? pickedIds : undefined;

  const restore = async (mode: 'new-windows' | 'current-window') => {
    const result = await toast.guard(rpc('session.restore', { id: summary.id, mode, windowId: live.currentWindowId, tabIds: restoreIds }));
    if (!result) return;
    const skipped = result.skipped.length ? ` ${plural(result.skipped.length, 'address')} could not be opened.` : '';
    toast.ok(`Restored ${plural(result.opened, 'tab')}.${skipped}`);
    setPicked(new Set());
  };

  const rename = async () => {
    const name = await dialogs.prompt({ title: 'Rename session', label: 'Name', initial: summary.name });
    if (name) await toast.guard(rpc('session.patch', { id: summary.id, name }));
  };

  const remove = async () => {
    const ok = await dialogs.confirm({ title: `Delete “${summary.name}”?`, body: `${plural(summary.tabCount, 'tab')} will move to Trash for 30 days.`, confirm: 'Delete', danger: true });
    if (!ok) return;
    await toast.guard(rpc('session.delete', { id: summary.id }));
    go('vault');
    toast.ok('Session deleted', { label: 'Undo', run: () => rpc('session.undelete', { id: summary.id }) });
  };

  const toWorkspace = async () => {
    const name = await dialogs.prompt({ title: 'Turn into a workspace', label: 'Workspace name', initial: summary.name.split(' · ')[0], confirm: 'Create' });
    if (!name) return;
    const ws = await toast.guard(rpc('session.toWorkspace', { id: summary.id, name }));
    if (ws) toast.ok(`Created ${ws.name}`, { label: 'View', run: () => go(`workspaces/${ws.id}`) });
  };

  const overwrite = async () => {
    const ok = await dialogs.confirm({ title: 'Update from what’s open now?', body: `This replaces the ${plural(summary.tabCount, 'tab')} saved in “${summary.name}” with your current windows.`, confirm: 'Update', danger: true });
    if (ok) {
      await toast.guard(rpc('session.updateFromCurrent', { id: summary.id }));
      toast.ok('Session updated');
    }
  };

  const copyMarkdown = () => {
    if (!session) return;
    const md = toMarkdown(session.name, session.windows.map((w, i) => ({ heading: session.windows.length > 1 ? `Window ${i + 1}` : undefined, tabs: w.tabs })));
    void navigator.clipboard.writeText(md).then(() => toast.ok('Copied as Markdown'));
  };

  const togglePick = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <>
      <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          <h2 style={{ fontSize: 17, fontWeight: 650, letterSpacing: '-0.015em' }}>{summary.name}</h2>
          <div className="status-line" style={{ flexWrap: 'wrap' }}>
            <span className="tag">{KIND_LABEL[summary.kind]}</span>
            {formatDateTime(summary.createdAt)} · {plural(summary.tabCount, 'tab')} in {plural(summary.windowCount, 'window')}
          </div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => void restore('new-windows')}>
            <ArchiveRestore size={14} />{restoreIds ? `Restore ${plural(restoreIds.length, 'tab')}` : 'Restore all'}
          </button>
          <Dropdown
            label="Restore options"
            align="right"
            trigger={(p) => <button className="btn" aria-label="Restore options" {...p}><ChevronDown size={14} /></button>}
            items={[
              { id: 'here', label: 'Restore into this window', icon: <PlusSquare size={15} />, run: () => void restore('current-window') },
              { id: 'new', label: 'Restore in new windows', icon: <AppWindow size={15} />, run: () => void restore('new-windows') },
            ]}
          />
          <Dropdown
            label="Session options"
            align="right"
            trigger={(p) => <button className="btn" aria-label="More session options" {...p}><MoreHorizontal size={15} /></button>}
            items={[
              { id: 'rename', label: 'Rename…', icon: <FileText size={15} />, run: () => void rename() },
              { id: 'keep', label: summary.keep ? 'Stop keeping' : 'Keep forever', icon: <Bookmark size={15} />, run: () => void toast.guard(rpc('session.patch', { id: summary.id, keep: !summary.keep })) },
              { id: 'ws', label: 'Turn into a workspace…', icon: <Layers size={15} />, run: () => void toWorkspace() },
              { id: 'update', label: 'Update from what’s open now…', icon: <RefreshCw size={15} />, disabled: summary.kind === 'auto', run: () => void overwrite() },
              { id: 'md', label: 'Copy as Markdown', icon: <FileText size={15} />, run: copyMarkdown },
              { id: 'delete', label: 'Delete', icon: <Trash2 size={15} />, danger: true, run: () => void remove() },
            ]}
          />
        </div>
      </div>

      {error && <div className="banner banner-danger" style={{ margin: '12px 0' }} role="alert"><X size={15} />{error}</div>}

      {allTabs.length > 0 && (
        <div className="row muted" style={{ fontSize: 12.5, marginTop: 10 }}>
          <button className="btn btn-sm btn-ghost" onClick={() => setPicked(pickedIds.length === allTabs.length ? new Set() : new Set(allTabs.map((t) => t.id)))}>
            {pickedIds.length === allTabs.length ? 'Select none' : 'Select all'}
          </button>
          {pickedIds.length > 0 ? `${pickedIds.length} selected. Restore opens only these.` : 'Tick tabs to restore only some of them.'}
        </div>
      )}

      {session?.windows.map((win, i) => (
        <div key={win.id} className="preview-window">
          {session.windows.length > 1 && (
            <div className="preview-window-head"><AppWindow size={13} />Window {i + 1} <span className="faint mono">{win.tabs.length}</span></div>
          )}
          <div className="card list">
            {win.tabs.map((tab) => {
              const group = tab.groupKey ? win.groups.find((g) => g.key === tab.groupKey) : undefined;
              return (
                <div key={tab.id} className="lrow">
                  <input type="checkbox" className="tab-check" aria-label={`Select ${tab.title}`} checked={picked.has(tab.id)} onChange={() => togglePick(tab.id)} />
                  <Favicon url={tab.url} />
                  <button className="lrow-body" style={{ textAlign: 'left' }} title="Open this tab" onClick={() => void toast.guard(rpc('tabs.open', { url: tab.url, active: false })).then(() => toast.ok('Opened in the background'))}>
                    <div className="lrow-title">{tab.title}</div>
                    <div className="lrow-sub">{displayUrl(tab.url)}</div>
                  </button>
                  {group?.title && <span className="tag">{group.title}</span>}
                  {summary.kind !== 'auto' && (
                    <span className="lrow-actions">
                      <IconButton label="Remove from session" className="is-danger" onClick={() => void toast.guard(rpc('session.removeTabs', { id: summary.id, tabIds: [tab.id] }))}><X size={14} /></IconButton>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}
