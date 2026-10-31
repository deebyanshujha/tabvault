import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  AppWindow, Archive, Copy, FileX2, HardDriveDownload, Hourglass, Keyboard, Layers, Plus, RotateCcw, ShieldCheck, Sparkles,
} from 'lucide-react';
import { analyzeClutter } from '../../../shared/clutter';
import { isProtectedByRules } from '../../../shared/rules';
import { timeAgo } from '../../../shared/time';
import { domainOf, isWorthSaving } from '../../../shared/urls';
import { cleanTitle } from '../../../shared/titles';
import { Empty, Favicon, Kbd, Stat, WorkspaceBadge, colorVar } from '../../components/common';
import { useDialogs, useToast } from '../../components/feedback';
import { closeWithUndo, openWorkspaceWithFeedback, plural, type ActionContext } from '../../lib/actions';
import { clutterShape, type ClosedEntry } from '../../lib/docs';
import { usePrefs, useVault, type LiveData } from '../../lib/hooks';
import { rpc } from '../../lib/rpc';

export function TodayView({ live, go }: { live: LiveData; go: (p: string) => void }) {
  const { vault } = useVault();
  const [prefs, updatePrefs] = usePrefs();
  const toast = useToast();
  const dialogs = useDialogs();
  const [closed, setClosed] = useState<ClosedEntry[]>([]);

  useEffect(() => {
    rpc('tabs.recentlyClosed', {}).then(setClosed, () => undefined);
  }, [live.tabs.length]);

  const ctx: ActionContext = useMemo(() => ({
    toast, dialogs, windowId: live.currentWindowId, workspaces: vault.workspaces, annotationFor: () => undefined, done: () => undefined,
  }), [toast, dialogs, live.currentWindowId, vault.workspaces]);

  const report = useMemo(
    () => analyzeClutter(
      live.tabs.map(clutterShape),
      { staleDays: prefs.staleDays, isProtected: (t) => isProtectedByRules(vault.rules, t) },
    ),
    [live.tabs, prefs.staleDays, vault.rules],
  );

  const asleep = live.tabs.filter((t) => t.discarded).length;
  const queued = vault.later.filter((i) => i.state === 'queued');
  const snapshots = vault.sessions.filter((s) => s.kind === 'auto');
  const lastSnapshot = snapshots[0];
  const hoardSuggestion = report.hoards.find((h) => !vault.workspaces.some((w) => w.name.toLowerCase() === h.domain.toLowerCase()));

  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const tidyCards = [];
  if (report.duplicateCount) {
    tidyCards.push(
      <div className="card tidy" key="dupes">
        <div className="tidy-head"><Copy size={15} />{plural(report.duplicateCount, 'duplicate tab')}</div>
        <p>The same page is open more than once. TabVault keeps the copy you used last.</p>
        <div className="tidy-icons">{report.duplicates.slice(0, 8).map((d) => <Favicon key={d.key} url={d.keep.url} />)}</div>
        <div className="row">
          <button className="btn btn-sm btn-primary" onClick={() => void toast.guard(rpc('tabs.closeDuplicates', {})).then((r) => {
            if (r?.closed) toast.ok(`Closed ${plural(r.closed, 'duplicate')}`, r.undoId ? { label: 'Undo', run: () => rpc('undo.run', { undoId: r.undoId! }) } : undefined);
          })}>Close duplicates</button>
          <button className="btn btn-sm btn-ghost" onClick={() => go('tabs')}>Review</button>
        </div>
      </div>,
    );
  }
  if (report.stale.length) {
    tidyCards.push(
      <div className="card tidy" key="stale">
        <div className="tidy-head"><Hourglass size={15} />{plural(report.stale.length, 'stale tab')}</div>
        <p>Not visited in over {plural(prefs.staleDays, 'day')}. Close them, or vault them to get them back later.</p>
        <div className="tidy-icons">{report.stale.slice(0, 8).map((t) => <Favicon key={t.id} url={t.url} />)}</div>
        <div className="row">
          <button className="btn btn-sm btn-primary" onClick={() => void toast.guard(rpc('session.save', { scope: 'tabs', tabIds: report.stale.map((t) => t.id), name: `Stale tabs · ${new Date().toLocaleDateString()}`, close: true })).then((s) => {
            if (s) toast.ok(`Vaulted ${plural(s.tabCount, 'stale tab')}`, { label: 'Open Vault', run: () => go(`vault/${s.id}`) });
          })}>Vault and close</button>
          <button className="btn btn-sm btn-ghost" onClick={() => void closeWithUndo(ctx, report.stale.map((t) => t.id))}>Just close</button>
        </div>
      </div>,
    );
  }
  if (report.blank.length >= 2) {
    tidyCards.push(
      <div className="card tidy" key="blank">
        <div className="tidy-head"><FileX2 size={15} />{plural(report.blank.length, 'empty tab')}</div>
        <p>New tab pages that were never used.</p>
        <div className="row"><button className="btn btn-sm btn-primary" onClick={() => void closeWithUndo(ctx, report.blank.map((t) => t.id))}>Close them</button></div>
      </div>,
    );
  }
  if (hoardSuggestion) {
    tidyCards.push(
      <div className="card tidy" key="hoard">
        <div className="tidy-head"><Sparkles size={15} />{hoardSuggestion.tabs.length} tabs on {hoardSuggestion.domain}</div>
        <p>That looks like a project. Make it a workspace so it can leave and come back as one.</p>
        <div className="tidy-icons"><Favicon url={hoardSuggestion.tabs[0]!.url} /> {hoardSuggestion.domain}</div>
        <div className="row">
          <button className="btn btn-sm btn-primary" onClick={() => void dialogs.prompt({ title: 'New workspace', label: 'Name', initial: hoardSuggestion.domain, confirm: 'Create' }).then((name) => {
            if (!name) return;
            return toast.guard(rpc('workspace.create', { name, tabIds: hoardSuggestion.tabs.map((t) => t.id) })).then((ws) => {
              if (ws) toast.ok(`Created ${ws.name}`, { label: 'View', run: () => go(`workspaces/${ws.id}`) });
            });
          })}>Make a workspace</button>
          <button className="btn btn-sm btn-ghost" onClick={() => void toast.guard(rpc('tabs.organize', {})).then((r) => r && toast.ok(`Made ${plural(r.groups, 'group')}`))}>Group by site</button>
        </div>
      </div>,
    );
  }
  if (report.singleTabWindows.length >= 2) {
    tidyCards.push(
      <div className="card tidy" key="windows">
        <div className="tidy-head"><AppWindow size={15} />{report.singleTabWindows.length} one-tab windows</div>
        <p>Scattered windows make everything harder to find.</p>
        <div className="row"><button className="btn btn-sm btn-primary" onClick={() => void toast.guard(rpc('tabs.mergeWindows', {})).then((n) => n !== undefined && toast.ok(`Moved ${plural(n, 'tab')}`))}>Merge windows</button></div>
      </div>,
    );
  }

  return (
    <div className="page">
      <section className="hero">
        <div className="hero-kicker">{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        <h1 className="page-title">{greeting}. <em>{plural(live.tabs.length, 'tab')}</em> open.</h1>
        <div className="stat-line">
          <Stat value={live.tabs.length} label={`open in ${plural(live.windows.length, 'window')}`} onClick={() => go('tabs')} />
          <Stat value={asleep} label="asleep" />
          <Stat value={report.duplicateCount} label="duplicates" />
          <Stat value={queued.length} label="in Later" onClick={() => go('later')} />
          <Stat value={snapshots.length} label={lastSnapshot ? `snapshots, last ${timeAgo(lastSnapshot.createdAt)}` : 'snapshots so far'} onClick={() => go('vault')} />
        </div>
      </section>
      <div className="page-inner">
        {!prefs.onboarded && (
          <div className="card onboard">
            <h2>Your browser, organized by what you’re doing</h2>
            <p className="muted">Nothing leaves this device: no account, no server, no analytics. Three things to know:</p>
            <div className="onboard-steps">
              <div className="onboard-step"><Layers size={16} /><div><b>Workspaces save themselves</b>Make this window a workspace and it stays up to date as you browse. Close it whenever.</div></div>
              <div className="onboard-step"><Keyboard size={16} /><div><b>Press <Kbd>Alt</Kbd> <Kbd>K</Kbd> anywhere</b>Search every tab you have or had. Type &gt; to run a command.</div></div>
              <div className="onboard-step"><ShieldCheck size={16} /><div><b>Tabs are hard to lose</b>Time Machine snapshots your session. Closed windows and restarts are recoverable.</div></div>
            </div>
            <div className="row">
              <button className="btn btn-primary" onClick={() => { updatePrefs({ onboarded: true }); go('workspaces/new'); }}><Plus size={14} />Create a workspace</button>
              <button className="btn" onClick={() => updatePrefs({ onboarded: true })}>Got it</button>
            </div>
          </div>
        )}

        {vault.recovery && (
          <div className="banner" style={{ margin: '0 0 16px' }}>
            <RotateCcw size={16} />
            <span className="spacer"><b>{plural(vault.recovery.missing, 'tab')}</b> from {timeAgo(vault.recovery.at)} didn’t come back after the restart.</span>
            <button className="btn btn-sm btn-primary" onClick={() => void toast.guard(rpc('recovery.restore', {})).then((r) => r && toast.ok(`Restored ${plural(r.opened, 'tab')}`))}>Restore</button>
            <button className="btn btn-sm" onClick={() => go(`vault/${vault.recovery!.sessionId}`)}>Preview</button>
            <button className="btn btn-sm btn-ghost" onClick={() => void toast.guard(rpc('recovery.dismiss', {}))}>Dismiss</button>
          </div>
        )}

        <div className="section-title" style={{ marginTop: prefs.onboarded && !vault.recovery ? 0 : undefined }}>Worth <em>tidying</em></div>
        {tidyCards.length ? (
          <div className="tidy-grid">{tidyCards}</div>
        ) : (
          <div className="card"><Empty icon={<Sparkles size={20} />} title="Nothing needs attention">No duplicates, stale tabs or sprawl right now.</Empty></div>
        )}

        <div className="section-title">Your <em>workspaces</em></div>
        {vault.workspaces.length ? (
          <div className="ws-grid">
            {vault.workspaces.slice(0, 6).map((ws) => {
              const isLive = Object.values(vault.bindings).includes(ws.id);
              return (
                <div key={ws.id} className="card ws-card" style={{ '--ws': colorVar(ws.color) } as CSSProperties} onClick={() => go(`workspaces/${ws.id}`)}>
                  <div className="ws-card-head">
                    <WorkspaceBadge color={ws.color} icon={ws.icon} />
                    <div style={{ minWidth: 0 }}>
                      <div className="ws-card-name truncate">{ws.name}</div>
                      <div className="ws-card-sub">{plural(ws.items.length, 'tab')}{isLive ? ' · open now' : ws.lastOpenedAt ? ` · ${timeAgo(ws.lastOpenedAt)}` : ''}</div>
                    </div>
                  </div>
                  <div className="ws-card-actions">
                    <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); void openWorkspaceWithFeedback(ctx, ws); }}>{isLive ? 'Go to window' : 'Open'}</button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="card">
            <Empty icon={<Layers size={20} />} title="No workspaces yet" action={<button className="btn btn-primary" onClick={() => go('workspaces/new')}><Plus size={14} />Create a workspace</button>}>
              Give each thing you’re doing its own set of tabs, and switch between them without losing any.
            </Empty>
          </div>
        )}

        <div className="two-col today-lists">
          <div>
            <div className="section-title">Up next in <em>Later</em></div>
            <div className="card list">
              {queued.length ? queued.slice(0, 5).map((i) => (
                <button key={i.id} className="lrow" onClick={() => void toast.guard(rpc('later.open', { id: i.id }))}>
                  <Favicon url={i.url} />
                  <div className="lrow-body">
                    <div className="lrow-title">{cleanTitle(i.title, i.url)}</div>
                    <div className="lrow-sub">{domainOf(i.url)} · {timeAgo(i.addedAt)}</div>
                  </div>
                </button>
              )) : <Empty icon={<Archive size={20} />} title="Queue is empty">Press <Kbd>Alt</Kbd> <Kbd>Shift</Kbd> <Kbd>S</Kbd> to send a tab here.</Empty>}
            </div>
          </div>
          <div>
            <div className="section-title">Recently <em>closed</em></div>
            <div className="card list">
              {closed.length ? closed.filter((c) => isWorthSaving(c.url)).slice(0, 5).map((c) => (
                <button key={c.sessionId} className="lrow" onClick={() => void toast.guard(rpc('tabs.reopenClosed', { sessionId: c.sessionId }))}>
                  <Favicon url={c.url} />
                  <div className="lrow-body">
                    <div className="lrow-title">{c.kind === 'window' ? `Window with ${plural(c.tabCount, 'tab')}` : cleanTitle(c.title, c.url)}</div>
                    <div className="lrow-sub">{domainOf(c.url)} · {timeAgo(c.at)}</div>
                  </div>
                  <RotateCcw size={14} className="faint" />
                </button>
              )) : <Empty icon={<HardDriveDownload size={20} />} title="Nothing closed yet">Closed tabs show up here, ready to bring back.</Empty>}
            </div>
          </div>
        </div>
      </div>
      <footer className="colophon">
        <div className="colophon-line"><span>Everything here stays on this device.</span><span>No account. No server. No analytics.</span></div>
        <div className="colophon-word" aria-hidden="true">Tab<em>Vault</em></div>
      </footer>
    </div>
  );
}

