import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  AppWindow, ChevronDown, FileText, GripVertical, Layers, Link2, ListPlus, NotebookPen, Pin, Plus, RefreshCw, Replace, SquareStack, Trash2, X, XSquare,
} from 'lucide-react';
import { TAB_COLORS, WORKSPACE_ICONS, type TabColor, type Workspace, type WorkspaceIcon } from '../../../shared/types';
import { domainOf, isRestorable, urlKey } from '../../../shared/urls';
import { cleanTitle } from '../../../shared/titles';
import { timeAgo } from '../../../shared/time';
import { toMarkdown } from '../../../shared/importers';
import { Dropdown, Empty, Favicon, IconButton, Switch, WORKSPACE_ICON_MAP, WorkspaceBadge, colorVar } from '../../components/common';
import { Dialog, useDialogs, useToast } from '../../components/feedback';
import { editNote, openWorkspaceWithFeedback, plural, type ActionContext } from '../../lib/actions';
import { annotationMap } from '../../lib/docs';
import { useVault, type LiveData } from '../../lib/hooks';
import { rpc } from '../../lib/rpc';

interface Template {
  id: string;
  name: string;
  color: TabColor;
  icon: WorkspaceIcon;
  links: { url: string; title: string }[];
}

const TEMPLATES: Template[] = [
  { id: 'college', name: 'College', color: 'blue', icon: 'graduation', links: [] },
  { id: 'dev', name: 'Development', color: 'green', icon: 'code', links: [
    { url: 'https://github.com/pulls', title: 'GitHub pull requests' }, { url: 'https://developer.mozilla.org/', title: 'MDN Web Docs' },
  ] },
  { id: 'research', name: 'Research', color: 'purple', icon: 'flask', links: [{ url: 'https://scholar.google.com/', title: 'Google Scholar' }] },
  { id: 'interview', name: 'Interview prep', color: 'orange', icon: 'briefcase', links: [{ url: 'https://leetcode.com/problemset/', title: 'LeetCode problems' }] },
  { id: 'fun', name: 'Entertainment', color: 'pink', icon: 'film', links: [] },
  { id: 'personal', name: 'Personal', color: 'cyan', icon: 'user', links: [] },
];

export function WorkspacesView({ live, param, go }: { live: LiveData; param?: string; go: (p: string) => void }) {
  const { vault, loading } = useVault();
  if (param === 'new') return <><WorkspacesGrid live={live} go={go} /><NewWorkspaceDialog live={live} go={go} /></>;
  if (param) {
    const ws = vault.workspaces.find((w) => w.id === param);
    if (ws) return <WorkspaceDetail ws={ws} live={live} go={go} />;
    if (!loading) {
      return (
        <div className="page"><div className="page-inner">
          <Empty icon={<Layers size={20} />} title="That workspace is gone" action={<button className="btn" onClick={() => go('workspaces')}>All workspaces</button>}>It may have been deleted. Deleted workspaces stay in Settings → Trash for 30 days.</Empty>
        </div></div>
      );
    }
  }
  return <WorkspacesGrid live={live} go={go} />;
}

function useCtx(live: LiveData): ActionContext {
  const { vault } = useVault();
  const toast = useToast();
  const dialogs = useDialogs();
  return useMemo(() => ({
    toast, dialogs, windowId: live.currentWindowId, workspaces: vault.workspaces, done: () => undefined,
    annotationFor: (url) => vault.annotations.find((a) => a.urlKey === urlKey(url))?.note,
  }), [toast, dialogs, live.currentWindowId, vault.workspaces, vault.annotations]);
}

function WorkspacesGrid({ live, go }: { live: LiveData; go: (p: string) => void }) {
  const { vault, loading } = useVault();
  const ctx = useCtx(live);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const reorder = (targetId: string) => {
    if (!dragging || dragging === targetId) return;
    const ids = vault.workspaces.map((w) => w.id).filter((id) => id !== dragging);
    ids.splice(ids.indexOf(targetId), 0, dragging);
    void ctx.toast.guard(rpc('workspace.reorder', { ids }));
  };
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1 className="page-title">Your <em>workspaces</em></h1>
            <div className="page-sub">A workspace bound to a window saves itself as you browse. Switch away and every tab is still there when you come back.</div>
          </div>
        </div>
        {!vault.workspaces.length && !loading ? (
          <div className="card">
            <Empty icon={<Layers size={20} />} title="Make your first workspace" action={<button className="btn btn-primary" onClick={() => go('workspaces/new')}><Plus size={14} />New workspace</button>}>
              One for each thing you’re doing: a course, a project, job hunting. Start empty, from a template, or from the window you’re in.
            </Empty>
          </div>
        ) : (
          <div className="ws-grid">
            {vault.workspaces.map((ws) => {
              const isLive = Object.values(vault.bindings).includes(ws.id);
              return (
                <div
                  key={ws.id}
                  className="card ws-card"
                  draggable
                  style={{ '--ws': colorVar(ws.color), outline: over === ws.id ? '2px dashed var(--accent)' : undefined } as CSSProperties}
                  onDragStart={() => setDragging(ws.id)}
                  onDragEnd={() => { setDragging(null); setOver(null); }}
                  onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(ws.id); } }}
                  onDragLeave={() => setOver(null)}
                  onDrop={(e) => { e.preventDefault(); reorder(ws.id); setOver(null); }}
                  onClick={() => go(`workspaces/${ws.id}`)}
                >
                  <div className="ws-card-head">
                    <WorkspaceBadge color={ws.color} icon={ws.icon} size={32} />
                    <div style={{ minWidth: 0 }}>
                      <div className="ws-card-name truncate">{ws.name}</div>
                      <div className="ws-card-sub">{plural(ws.items.length, 'tab')}{isLive ? ' · open now' : ws.lastOpenedAt ? ` · ${timeAgo(ws.lastOpenedAt)}` : ''}</div>
                    </div>
                  </div>
                  <div className="ws-icons">
                    {ws.items.slice(0, 9).map((t) => <Favicon key={t.id} url={t.url} size={14} />)}
                    {ws.items.length > 9 && <span>+{ws.items.length - 9}</span>}
                    {!ws.items.length && <span>No tabs yet</span>}
                  </div>
                  <div className="ws-card-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="btn btn-sm" onClick={() => void openWorkspaceWithFeedback(ctx, ws)}>{isLive ? 'Go to window' : 'Open'}</button>
                    {!isLive && <button className="btn btn-sm btn-ghost" title="Save this window's tabs, then show this workspace in it" onClick={() => void openWorkspaceWithFeedback(ctx, ws, 'replace')}>Switch here</button>}
                  </div>
                </div>
              );
            })}
            <button className="card ws-card ws-new" onClick={() => go('workspaces/new')}><Plus size={18} />New workspace</button>
          </div>
        )}
      </div>
    </div>
  );
}

function NewWorkspaceDialog({ live, go }: { live: LiveData; go: (p: string) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [color, setColor] = useState<TabColor>('blue');
  const [icon, setIcon] = useState<WorkspaceIcon>('layers');
  const [template, setTemplate] = useState<string | null>(null);
  const [source, setSource] = useState<'empty' | 'window'>('empty');
  const close = () => go('workspaces');
  const pick = (t: Template) => {
    setTemplate(t.id);
    setName(t.name);
    setColor(t.color);
    setIcon(t.icon);
  };
  const windowTabs = live.tabs.filter((t) => t.windowId === live.currentWindowId && !(t.url ?? '').startsWith('chrome-extension://')).length;
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const fromWindow = source === 'window' && live.currentWindowId !== undefined;
    const ws = await toast.guard(rpc('workspace.create', {
      name: trimmed, color, icon,
      links: TEMPLATES.find((t) => t.id === template)?.links,
      ...(fromWindow ? { fromWindowId: live.currentWindowId, bind: true } : {}),
    }));
    if (ws) {
      toast.ok(fromWindow ? `“${ws.name}” is live in this window` : `Created ${ws.name}`);
      go(`workspaces/${ws.id}`);
    }
  };
  return (
    <Dialog title="New workspace" onClose={close} wide>
      <span className="field-label">Start from</span>
      <div className="template-grid">
        {TEMPLATES.map((t) => (
          <button key={t.id} type="button" className={`template${template === t.id ? ' is-on' : ''}`} onClick={() => pick(t)}>
            <WorkspaceBadge color={t.color} icon={t.icon} size={22} />{t.name}
          </button>
        ))}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="ws-name">Name</label>
        <input id="ws-name" className="input" data-autofocus value={name} placeholder="What’s this for?" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      </div>
      <div className="field">
        <span className="field-label">Colour</span>
        <ColorPicker value={color} onChange={setColor} />
      </div>
      <div className="field">
        <span className="field-label">Icon</span>
        <IconPicker value={icon} onChange={setIcon} />
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <span className="field-label">Tabs</span>
        <label className="row" style={{ marginBottom: 4 }}><input type="radio" name="ws-src" checked={source === 'empty'} onChange={() => setSource('empty')} /> {template && TEMPLATES.find((t) => t.id === template)?.links.length ? 'Just the template’s starter links' : 'Start empty'}</label>
        <label className="row"><input type="radio" name="ws-src" checked={source === 'window'} onChange={() => setSource('window')} /> This window’s {plural(windowTabs, 'tab')}, and keep it in sync</label>
      </div>
      <div className="dialog-actions">
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn btn-primary" disabled={!name.trim()} onClick={() => void submit()}>Create workspace</button>
      </div>
    </Dialog>
  );
}

function ColorPicker({ value, onChange }: { value: TabColor; onChange: (c: TabColor) => void }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Colour">
      {TAB_COLORS.map((c) => (
        <button key={c} type="button" className="swatch" role="radio" aria-checked={c === value} aria-label={c} style={{ '--ws': colorVar(c) } as CSSProperties} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

function IconPicker({ value, onChange }: { value: WorkspaceIcon; onChange: (i: WorkspaceIcon) => void }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Icon">
      {WORKSPACE_ICONS.map((i) => {
        const Icon = WORKSPACE_ICON_MAP[i];
        return <button key={i} type="button" className="icon-pick" role="radio" aria-checked={i === value} aria-label={i} onClick={() => onChange(i)}><Icon size={16} /></button>;
      })}
    </div>
  );
}

function WorkspaceDetail({ ws, live, go }: { ws: Workspace; live: LiveData; go: (p: string) => void }) {
  const { vault } = useVault();
  const ctx = useCtx(live);
  const { toast, dialogs } = ctx;
  const [name, setName] = useState(ws.name);
  const [editOpen, setEditOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const notes = useMemo(() => annotationMap(vault.annotations), [vault.annotations]);

  useEffect(() => setName(ws.name), [ws.name]);

  const boundWindow = Object.entries(vault.bindings).find(([, id]) => id === ws.id)?.[0];
  const isLive = boundWindow !== undefined;
  const currentWindowBound = live.currentWindowId !== undefined && vault.bindings[String(live.currentWindowId)];

  const saveName = () => {
    const next = name.trim();
    if (next && next !== ws.name) void toast.guard(rpc('workspace.update', { id: ws.id, name: next }));
    else setName(ws.name);
  };

  const remove = async () => {
    const ok = await dialogs.confirm({
      title: `Delete ${ws.name}?`,
      body: <>Its {plural(ws.items.length, 'saved tab')} move to Trash for 30 days. {isLive ? 'The open window stays open.' : ''}</>,
      confirm: 'Delete', danger: true,
    });
    if (!ok) return;
    await toast.guard(rpc('workspace.delete', { id: ws.id }));
    go('workspaces');
    toast.ok(`Deleted ${ws.name}`, { label: 'Undo', run: () => rpc('workspace.undelete', { id: ws.id }) });
  };

  const addLink = async () => {
    const url = await dialogs.prompt({ title: 'Add a link', label: 'Address', placeholder: 'https://…', confirm: 'Add' });
    if (!url) return;
    const normalized = /^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    if (!isRestorable(normalized)) {
      toast.error('That doesn’t look like an address TabVault can open.');
      return;
    }
    const added = await toast.guard(rpc('workspace.addLink', { id: ws.id, url: normalized, title: normalized }));
    if (added === false) toast.info('This page can’t be saved.');
  };

  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = ws.items.map((t) => t.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    void toast.guard(rpc('workspace.reorderItems', { id: ws.id, itemIds: ids }));
  };

  const others = vault.workspaces.filter((w) => w.id !== ws.id);

  return (
    <div className="page">
      <div className="page-inner">
        <div className="detail-head">
          <button title="Change colour and icon" aria-label="Change colour and icon" onClick={() => setEditOpen(true)}>
            <WorkspaceBadge color={ws.color} icon={ws.icon} size={38} />
          </button>
          <div style={{ minWidth: 0, flex: 1 }}>
            <input
              ref={nameRef}
              className="inline-name"
              aria-label="Workspace name"
              value={name}
              size={Math.max(name.length, 4)}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') nameRef.current?.blur();
                if (e.key === 'Escape') { setName(ws.name); nameRef.current?.blur(); }
              }}
            />
            <div className="status-line">
              {isLive
                ? <><span className="dot dot-live" style={{ '--ws': colorVar(ws.color) } as CSSProperties} />Open in a window{ws.autoSync ? ', saving automatically' : ''}</>
                : <>{plural(ws.items.length, 'tab')} saved · updated {timeAgo(ws.updatedAt)}</>}
            </div>
          </div>
          <div className="row">
            {isLive ? (
              <>
                <button className="btn btn-primary" onClick={() => void openWorkspaceWithFeedback(ctx, ws)}>Go to window</button>
                <button className="btn" title="Save and close the window" onClick={() => void toast.guard(rpc('workspace.closeWindow', { id: ws.id })).then(() => toast.ok(`${ws.name} saved and closed`))}><XSquare size={14} />Close</button>
              </>
            ) : (
              <>
                <button className="btn btn-primary" onClick={() => void openWorkspaceWithFeedback(ctx, ws, 'new-window')}><AppWindow size={14} />Open in new window</button>
                <Dropdown
                  label="More ways to open"
                  align="right"
                  trigger={(p) => <button className="btn" {...p} aria-label="More ways to open"><ChevronDown size={14} /></button>}
                  items={[
                    { id: 'switch', label: 'Switch this window to it', icon: <Replace size={15} />, hint: 'parks current tabs', run: () => void openWorkspaceWithFeedback(ctx, ws, 'replace') },
                    { id: 'append', label: 'Add its tabs to this window', icon: <SquareStack size={15} />, run: () => void openWorkspaceWithFeedback(ctx, ws, 'append') },
                    { id: 'bind', label: 'Bind this window to it', icon: <RefreshCw size={15} />, hint: 'keep in sync', disabled: live.currentWindowId === undefined || !!currentWindowBound, run: () => void toast.guard(rpc('workspace.bind', { windowId: live.currentWindowId!, id: ws.id })).then(() => toast.ok(`This window is now ${ws.name}`)) },
                  ]}
                />
              </>
            )}
            <Dropdown
              label="Workspace options"
              align="right"
              trigger={(p) => <button className="btn" {...p}>More</button>}
              items={[
                { id: 'edit', label: 'Colour and icon…', icon: <Layers size={15} />, run: () => setEditOpen(true) },
                { id: 'overwrite', label: 'Replace with this window’s tabs', icon: <RefreshCw size={15} />, disabled: live.currentWindowId === undefined || isLive, run: () => void dialogs.confirm({ title: `Replace ${ws.name}’s tabs?`, body: `Its ${plural(ws.items.length, 'saved tab')} will be replaced by the tabs in this window.`, confirm: 'Replace', danger: true }).then((ok) => { if (ok) void toast.guard(rpc('workspace.saveFromWindow', { id: ws.id, windowId: live.currentWindowId! })); }) },
                { id: 'copy', label: 'Copy as Markdown', icon: <FileText size={15} />, run: () => void navigator.clipboard.writeText(toMarkdown(ws.name, [{ tabs: ws.items }])).then(() => toast.ok('Copied as Markdown')) },
                ...(isLive ? [{ id: 'unbind', label: 'Stop syncing with its window', icon: <X size={15} />, run: () => void toast.guard(rpc('workspace.bind', { windowId: Number(boundWindow), id: undefined })) }] : []),
                { id: 'delete', label: 'Delete workspace', icon: <Trash2 size={15} />, danger: true, run: () => void remove() },
              ]}
            />
          </div>
        </div>

        {isLive && (
          <div className="setting card" style={{ padding: '10px 14px', marginBottom: 12 }}>
            <div className="setting-text">
              <div className="setting-title">Keep in sync with its window</div>
              <div className="setting-desc">Tabs you open and close in that window update this list automatically.</div>
            </div>
            <Switch checked={ws.autoSync} label="Keep in sync" onChange={(v) => void toast.guard(rpc('workspace.update', { id: ws.id, autoSync: v }))} />
          </div>
        )}

        <div className="section-title">
          Tabs <span className="faint mono">{ws.items.length}</span>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={() => void addLink()}><Link2 size={13} />Add a link</button>
        </div>
        <div className="card list">
          {ws.items.length ? ws.items.map((item) => {
            const note = notes.get(urlKey(item.url))?.note;
            return (
              <div
                key={item.id}
                className={`lrow${dragId === item.id ? ' is-dragging' : ''}${overId === item.id ? ' drop-before' : ''}`}
                draggable
                onDragStart={() => setDragId(item.id)}
                onDragEnd={() => { setDragId(null); setOverId(null); }}
                onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverId(item.id); } }}
                onDragLeave={() => setOverId(null)}
                onDrop={(e) => { e.preventDefault(); dropOn(item.id); setOverId(null); }}
              >
                <span className="grip"><GripVertical size={14} /></span>
                <Favicon url={item.url} />
                <button className="lrow-body" style={{ textAlign: 'left' }} onClick={() => void toast.guard(rpc('tabs.open', { url: item.url }))}>
                  <div className="lrow-title" title={`${item.title}\n${item.url}`}>{cleanTitle(item.title, item.url)}</div>
                  <div className="lrow-sub">{note ? <span className="result-note"><NotebookPen size={11} />{note}</span> : domainOf(item.url)}</div>
                </button>
                {item.pinned && <Pin size={13} className="faint" aria-label="Pinned" />}
                <span className="lrow-actions">
                  <IconButton label="Add a note" onClick={() => void editNote(ctx, item.url)}><NotebookPen size={14} /></IconButton>
                  <IconButton label="Save to Later" onClick={() => void toast.guard(rpc('later.addLink', { url: item.url, title: item.title })).then(() => toast.ok('Saved to Later'))}><ListPlus size={14} /></IconButton>
                  {others.length > 0 && (
                    <Dropdown
                      label="Move to another workspace"
                      align="right"
                      trigger={(p) => <IconButton label="Move to another workspace" {...p}><Layers size={14} /></IconButton>}
                      items={others.map((o) => ({ id: o.id, label: o.name, run: () => void toast.guard(rpc('workspace.moveItems', { from: ws.id, to: o.id, itemIds: [item.id] })) }))}
                    />
                  )}
                  <IconButton label="Remove from workspace" className="is-danger" onClick={() => void toast.guard(rpc('workspace.removeItems', { id: ws.id, itemIds: [item.id] }))}><X size={14} /></IconButton>
                </span>
              </div>
            );
          }) : (
            <Empty icon={<SquareStack size={20} />} title="No tabs in here yet" action={<button className="btn" onClick={() => go('tabs')}>Go to open tabs</button>}>
              Drag tabs onto this workspace in the sidebar from the Open tabs page, or add links directly.
            </Empty>
          )}
        </div>
      </div>
      {editOpen && (
        <Dialog title="Colour and icon" onClose={() => setEditOpen(false)}>
          <div className="field">
            <span className="field-label">Colour</span>
            <ColorPicker value={ws.color} onChange={(color) => void toast.guard(rpc('workspace.update', { id: ws.id, color }))} />
          </div>
          <div className="field">
            <span className="field-label">Icon</span>
            <IconPicker value={ws.icon} onChange={(icon) => void toast.guard(rpc('workspace.update', { id: ws.id, icon }))} />
          </div>
          <div className="dialog-actions"><button className="btn btn-primary" data-autofocus onClick={() => setEditOpen(false)}>Done</button></div>
        </Dialog>
      )}
    </div>
  );
}
