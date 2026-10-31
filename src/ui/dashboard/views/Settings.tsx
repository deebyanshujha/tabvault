import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Download, HardDrive, Keyboard, RotateCcw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import type { Prefs } from '../../../shared/types';
import { timeAgo } from '../../../shared/time';
import { Kbd, Segmented, Switch } from '../../components/common';
import { Dialog, useDialogs, useToast } from '../../components/feedback';
import { plural } from '../../lib/actions';
import { usePrefs, useVault } from '../../lib/hooks';
import { rpc } from '../../lib/rpc';

const PERMISSIONS: [string, string][] = [
  ['tabs', 'Read titles and addresses of your tabs so they can be listed, searched and saved.'],
  ['tabGroups', 'Create, read and restore Chrome tab groups.'],
  ['sessions', 'List and reopen tabs from Chrome’s “recently closed”.'],
  ['storage, unlimitedStorage', 'Keep your workspaces and sessions on this device, safe from automatic eviction.'],
  ['alarms', 'Wake up for snapshots and snoozed tabs without running constantly.'],
  ['contextMenus', 'The right-click “Save to Later” and “Add to workspace” items.'],
  ['favicon', 'Show site icons from Chrome’s local cache, without contacting the sites.'],
  ['idle', 'Stop counting focus time when you step away.'],
  ['sidePanel', 'The optional vertical tab list.'],
];

function Setting({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      <div className="setting-text">
        <div className="setting-title">{title}</div>
        {desc && <div className="setting-desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function SettingsView() {
  const [prefs, update] = usePrefs();
  const { vault } = useVault();
  const toast = useToast();
  const dialogs = useDialogs();
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    navigator.storage.estimate().then((e) => setUsage({ usage: e.usage ?? 0, quota: e.quota ?? 0 }), () => undefined);
  }, [vault]);

  const set = <K extends keyof Prefs>(key: K) => (value: Prefs[K]) => update({ [key]: value } as Partial<Prefs>);

  const exportJson = async () => {
    const backup = await toast.guard(rpc('data.export', {}));
    if (!backup) return;
    download(`tabvault-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(backup, null, 2));
    toast.ok('Backup downloaded');
  };

  const importJson = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const summary = await toast.guard(file.text().then((json) => rpc('data.import', { json })));
    if (summary) {
      const kept = `${plural(summary.workspaces, 'workspace')}, ${plural(summary.sessions, 'session')}, ${summary.later} in Later`;
      toast.ok(`Imported ${kept}.${summary.rejected ? ` ${plural(summary.rejected, 'record')} skipped as invalid.` : ''}`);
    }
  };

  const wipe = async () => {
    const ok = await dialogs.confirm({
      title: 'Delete everything?',
      body: 'All workspaces, sessions, snapshots, notes, rules and insights on this device will be permanently erased. This can’t be undone. Export a backup first if you might want them.',
      confirm: 'Erase all data', danger: true,
    });
    if (!ok) return;
    await toast.guard(rpc('data.wipe', {}));
    toast.ok('All TabVault data erased');
  };

  const trashCount = vault.trash.workspaces.length + vault.trash.sessions.length;

  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 720 }}>
        <div className="page-head"><h1 className="page-title">Your <em>settings</em></h1></div>

        <div className="section-title" style={{ marginTop: 0 }}>Appearance</div>
        <div className="card settings-group">
          <Setting title="Theme">
            <Segmented<Prefs['theme']> label="Theme" value={prefs.theme} onChange={set('theme')} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          </Setting>
          <Setting title="Toolbar badge" desc="“Alerts” appears only when there’s something to recover.">
            <Segmented<Prefs['badge']> label="Toolbar badge" value={prefs.badge} onChange={set('badge')} options={[{ value: 'alerts', label: 'Alerts' }, { value: 'tabs', label: 'Tab count' }, { value: 'off', label: 'Off' }]} />
          </Setting>
        </div>

        <div className="section-title">Workspaces and restoring</div>
        <div className="card settings-group">
          <Setting title="Opening a workspace" desc="“This window” saves the current tabs first, then swaps them out.">
            <Segmented<Prefs['workspaceOpenMode']> label="Opening a workspace" value={prefs.workspaceOpenMode} onChange={set('workspaceOpenMode')} options={[{ value: 'new-window', label: 'New window' }, { value: 'replace', label: 'This window' }]} />
          </Setting>
          <Setting title="Restore large sets asleep" desc="When restoring more than 5 tabs, put background ones to sleep once they’ve opened, so they don’t hold memory until you visit them.">
            <Switch checked={prefs.restoreAsleep} label="Restore large sets asleep" onChange={set('restoreAsleep')} />
          </Setting>
        </div>

        <div className="section-title">Protection</div>
        <div className="card settings-group">
          <Setting title="Time Machine" desc="Snapshot all windows every few minutes when something has changed. Keeps every snapshot for an hour, hourly for a day, daily for two weeks.">
            <Switch checked={prefs.timeMachine} label="Time Machine" onChange={set('timeMachine')} />
          </Setting>
          <Setting title="Save closed windows" desc="Closing a window with two or more tabs saves it to the Vault for 30 days.">
            <Switch checked={prefs.closedWindowGuard} label="Save closed windows" onChange={set('closedWindowGuard')} />
          </Setting>
        </div>

        <div className="section-title">Tab housekeeping</div>
        <div className="card settings-group">
          <Setting title="A tab is stale after" desc="Shows up in Today as worth tidying. Nothing closes without you.">
            <div className="row">
              <input className="input" type="number" min={1} max={365} aria-label="Days until stale" value={prefs.staleDays} onChange={(e) => {
                const n = Number(e.target.value);
                if (n >= 1) update({ staleDays: n });
              }} />
              <span className="muted">days</span>
            </div>
          </Setting>
          <Setting title="Auto-sleep inactive tabs" desc="Uses Chrome’s own tab discarding. Skips pinned tabs, tabs playing audio, and rule-protected sites. 0 is off.">
            <div className="row">
              <input className="input" type="number" min={0} max={10080} aria-label="Minutes until auto-sleep" value={prefs.autoSleepMinutes} onChange={(e) => {
                const n = Number(e.target.value);
                if (n >= 0) update({ autoSleepMinutes: n });
              }} />
              <span className="muted">min</span>
            </div>
          </Setting>
          <Setting title="Focus existing tab instead of opening a duplicate" desc="When a new tab opens a page that’s already open, go to that one and close the new one.">
            <Switch checked={prefs.focusExistingOnDuplicate} label="Focus existing tab" onChange={set('focusExistingOnDuplicate')} />
          </Setting>
        </div>

        <div className="section-title"><Keyboard size={13} />Shortcuts</div>
        <div className="card settings-group">
          <Setting title="Open TabVault"><Kbd>Alt K</Kbd></Setting>
          <Setting title="Jump to previous tab"><Kbd>Alt Q</Kbd></Setting>
          <Setting title="Send tab to Later"><Kbd>Alt Shift S</Kbd></Setting>
          <Setting title="Open dashboard"><Kbd>Alt Shift D</Kbd></Setting>
          <Setting title="Change them" desc="Chrome manages extension shortcuts on its own page.">
            <button className="btn btn-sm" onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}>Open</button>
          </Setting>
        </div>

        <div className="section-title"><ShieldCheck size={13} />Privacy</div>
        <div className="card settings-group">
          <Setting title="Remember where tabs came from" desc="Stores the title and address of the page that opened each tab, so you can see why it’s open.">
            <Switch checked={prefs.provenance} label="Remember where tabs came from" onChange={set('provenance')} />
          </Setting>
          <Setting title="Activity insights" desc="Per-site focus time and tab counts. Sites only, never individual pages.">
            <Switch checked={prefs.activity} label="Activity insights" onChange={set('activity')} />
          </Setting>
          <Setting title="Clear activity data">
            <button className="btn btn-sm" onClick={() => void dialogs.confirm({ title: 'Clear activity data?', body: 'Focus time and tab counts will be erased. Workspaces and sessions aren’t affected.', confirm: 'Clear', danger: true }).then((ok) => { if (ok) void toast.guard(rpc('data.clearActivity', {})).then(() => toast.ok('Activity cleared')); })}>Clear</button>
          </Setting>
          <div className="setting" style={{ display: 'block' }}>
            <div className="setting-title" style={{ marginBottom: 2 }}>What TabVault can and can’t do</div>
            <div className="setting-desc" style={{ marginBottom: 8 }}>
              No account, no server, no analytics. The extension’s pages run under a security policy with <span className="mono">connect-src 'none'</span>, so they’re blocked by Chrome itself from sending data anywhere. Everything below stays on this device.
            </div>
            <table className="perm-table">
              <tbody>
                {PERMISSIONS.map(([name, why]) => <tr key={name}><td>{name}</td><td>{why}</td></tr>)}
              </tbody>
            </table>
          </div>
        </div>

        <div className="section-title"><HardDrive size={13} />Your data</div>
        <div className="card settings-group">
          <Setting title="Export backup" desc="Workspaces, saved sessions, Later, notes, rules and settings as one JSON file. Time Machine snapshots aren’t included.">
            <button className="btn btn-sm" onClick={() => void exportJson()}><Download size={13} />Export</button>
          </Setting>
          <Setting title="Import backup" desc="Merges into what’s here. Nothing existing is removed, and on a clash the newer version wins.">
            <button className="btn btn-sm" onClick={() => fileInput.current?.click()}><Upload size={13} />Choose file</button>
            <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => void importJson(e)} aria-label="Backup file" />
          </Setting>
          <Setting title="Import a list of links" desc="Paste URLs, one per line. OneTab exports work too.">
            <button className="btn btn-sm" onClick={() => setImportOpen(true)}>Paste links</button>
          </Setting>
          {usage && (
            <Setting title="Storage used" desc="Everything TabVault keeps on this device.">
              <span className="muted mono">{formatBytes(usage.usage)}</span>
            </Setting>
          )}
          {vault.quarantined > 0 && (
            <Setting title="Unreadable records" desc={`${plural(vault.quarantined, 'record')} couldn’t be read and were set aside instead of deleted. The rest of your data is unaffected.`}>
              <span className="tag tag-danger">{vault.quarantined}</span>
            </Setting>
          )}
          <Setting title="Delete all data" desc="Erase everything TabVault has stored on this device.">
            <button className="btn btn-sm" style={{ color: 'var(--danger)' }} onClick={() => void wipe()}><Trash2 size={13} />Erase</button>
          </Setting>
        </div>

        <div className="section-title"><Trash2 size={13} />Trash <span className="faint mono">{trashCount}</span></div>
        <div className="card list">
          {!trashCount && <div className="muted" style={{ padding: '10px 8px' }}>Empty. Deleted workspaces and sessions stay here for 30 days.</div>}
          {vault.trash.workspaces.map((w) => (
            <TrashRow key={w.id} title={w.name} sub={`Workspace · ${plural(w.items.length, 'tab')} · deleted ${timeAgo(w.deletedAt ?? 0)}`}
              onRestore={() => void toast.guard(rpc('workspace.undelete', { id: w.id }))}
              onPurge={() => void dialogs.confirm({ title: `Permanently delete ${w.name}?`, confirm: 'Delete forever', danger: true }).then((ok) => { if (ok) void toast.guard(rpc('workspace.purge', { id: w.id })); })} />
          ))}
          {vault.trash.sessions.map((s) => (
            <TrashRow key={s.id} title={s.name} sub={`Session · ${plural(s.tabCount, 'tab')} · deleted ${timeAgo(s.deletedAt ?? 0)}`}
              onRestore={() => void toast.guard(rpc('session.undelete', { id: s.id }))}
              onPurge={() => void dialogs.confirm({ title: `Permanently delete “${s.name}”?`, confirm: 'Delete forever', danger: true }).then((ok) => { if (ok) void toast.guard(rpc('session.purge', { id: s.id })); })} />
          ))}
        </div>
      </div>
      {importOpen && <ImportLinksDialog onClose={() => setImportOpen(false)} />}
    </div>
  );
}

function TrashRow({ title, sub, onRestore, onPurge }: { title: string; sub: string; onRestore: () => void; onPurge: () => void }) {
  return (
    <div className="lrow">
      <div className="lrow-body"><div className="lrow-title">{title}</div><div className="lrow-sub">{sub}</div></div>
      <button className="btn btn-sm" onClick={onRestore}><RotateCcw size={13} />Restore</button>
      <button className="btn btn-sm btn-ghost" onClick={onPurge}>Delete forever</button>
    </div>
  );
}

function ImportLinksDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const submit = async () => {
    const r = await toast.guard(rpc('data.importLinks', { text, name }));
    if (r) {
      toast.ok(`Imported ${plural(r.tabs, 'link')} into the Vault.${r.ignored ? ` ${r.ignored} line${r.ignored === 1 ? '' : 's'} ignored.` : ''}`);
      onClose();
    }
  };
  return (
    <Dialog title="Import a list of links" onClose={onClose} wide>
      <div className="field">
        <label className="field-label" htmlFor="import-name">Session name (optional)</label>
        <input id="import-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field" style={{ marginBottom: 0 }}>
        <label className="field-label" htmlFor="import-text">Links</label>
        <textarea id="import-text" className="input textarea mono" rows={9} data-autofocus value={text} onChange={(e) => setText(e.target.value)} placeholder={'https://example.com | Optional title\nhttps://another.example\n\nA blank line starts a new window'} />
      </div>
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!text.trim()} onClick={() => void submit()}>Import</button>
      </div>
    </Dialog>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
