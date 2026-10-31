import { useCallback, useEffect, useMemo, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import {
  Archive, BarChart3, Clock4, Command, Gauge, Keyboard, Layers, Plus, Search, Settings2, ShieldCheck, SlidersHorizontal, SquareStack, Sun, Moon,
} from 'lucide-react';
import { mount } from './Root';
import { Palette } from './palette/Palette';
import { IconButton, Kbd, Logo, WorkspaceBadge, colorVar } from './components/common';
import { Dialog, useToast } from './components/feedback';
import { useHashRoute, useLiveTabs, usePrefs, useVault, type LiveData } from './lib/hooks';
import { rpc } from './lib/rpc';
import { TodayView } from './dashboard/views/Today';
import { TabsView } from './dashboard/views/Tabs';
import { WorkspacesView } from './dashboard/views/Workspaces';
import { VaultView } from './dashboard/views/Vault';
import { LaterView } from './dashboard/views/Later';
import { RulesView } from './dashboard/views/Rules';
import { InsightsView } from './dashboard/views/Insights';
import { SettingsView } from './dashboard/views/Settings';
import { TAB_DRAG_TYPE, readDraggedTabs } from './dashboard/dnd';
import { reportAdded } from './lib/actions';

const NAV: { id: string; label: string; icon: typeof Gauge; chord: string }[] = [
  { id: 'today', label: 'Today', icon: Gauge, chord: 'H' },
  { id: 'tabs', label: 'Open tabs', icon: SquareStack, chord: 'T' },
  { id: 'workspaces', label: 'Workspaces', icon: Layers, chord: 'W' },
  { id: 'vault', label: 'Vault', icon: Archive, chord: 'V' },
  { id: 'later', label: 'Later', icon: Clock4, chord: 'L' },
  { id: 'rules', label: 'Rules', icon: SlidersHorizontal, chord: 'R' },
  { id: 'insights', label: 'Insights', icon: BarChart3, chord: 'I' },
];

function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  return !!node && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT' || node.isContentEditable);
}

function App() {
  const [route, go] = useHashRoute();
  const live = useLiveTabs();
  const { vault, loading } = useVault();
  const [prefs, updatePrefs] = usePrefs();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const view = route[0] ?? 'today';
  const navIndex = NAV.findIndex((n) => n.id === view);

  useEffect(() => {
    let pendingG = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
      if (e.key === '/') {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === '?') {
        setHelpOpen(true);
      } else if (e.key.toLowerCase() === 'g') {
        pendingG = Date.now();
      } else if (Date.now() - pendingG < 900) {
        pendingG = 0;
        const target = NAV.find((n) => n.chord.toLowerCase() === e.key.toLowerCase());
        if (target) go(target.id);
        else if (e.key.toLowerCase() === 's') go('settings');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  useEffect(() => {
    const label = NAV.find((n) => n.id === view)?.label ?? (view === 'settings' ? 'Settings' : '');
    document.title = label ? `${label} · TabVault` : 'TabVault';
  }, [view]);

  const counts: Record<string, number | undefined> = {
    tabs: live.tabs.length,
    later: vault.later.filter((i) => i.state === 'queued').length || undefined,
    vault: vault.sessions.filter((s) => s.kind !== 'auto').length || undefined,
  };

  const resolvedDark = prefs.theme === 'dark' || (prefs.theme === 'system' && !window.matchMedia('(prefers-color-scheme: light)').matches);

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand"><Logo size={26} /><span className="brand-name">Tab<em>Vault</em></span></div>
        <button className="search-trigger" onClick={() => setPaletteOpen(true)}>
          <Search size={14} />
          <span className="search-label spacer" style={{ textAlign: 'left' }}>Search everything</span>
          <Kbd>Ctrl K</Kbd>
        </button>
        <div className="nav-list">
          <span className="nav-indicator" hidden={navIndex < 0} style={{ '--i': Math.max(navIndex, 0) } as CSSProperties} />
          {NAV.map((n) => (
            <button key={n.id} className={`nav-item${view === n.id ? ' is-on' : ''}`} aria-current={view === n.id ? 'page' : undefined} onClick={() => go(n.id)} title={n.label}>
              <n.icon size={16} />
              <span className="nav-label">{n.label}</span>
              {counts[n.id] !== undefined && <span className="nav-count">{counts[n.id]}</span>}
            </button>
          ))}
        </div>
        <div className="nav-section">
          Workspaces
          <IconButton label="New workspace" style={{ width: 20, height: 20 }} onClick={() => go('workspaces/new')}><Plus size={13} /></IconButton>
        </div>
        <div className="nav-scroll">
          {vault.workspaces.map((ws) => (
            <SidebarWorkspace key={ws.id} id={ws.id} name={ws.name} active={route[0] === 'workspaces' && route[1] === ws.id} isLive={Object.values(vault.bindings).includes(ws.id)} colorStyle={{ '--ws': colorVar(ws.color) } as CSSProperties} badge={<WorkspaceBadge color={ws.color} icon={ws.icon} size={28} />} onOpen={() => go(`workspaces/${ws.id}`)} />
          ))}
          {!vault.workspaces.length && !loading && <div className="faint nav-label" style={{ padding: '2px 8px', fontSize: 12 }}>None yet. Workspaces you make appear here, and tabs can be dragged onto them.</div>}
        </div>
        <div className="sidebar-foot">
          <span className="privacy-pill" title="All data stays on this device. TabVault's pages are blocked from making network requests."><ShieldCheck size={13} /><span>Local only</span></span>
          <span className="spacer" />
          <IconButton label={resolvedDark ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => updatePrefs({ theme: resolvedDark ? 'light' : 'dark' })}>
            {resolvedDark ? <Sun size={15} /> : <Moon size={15} />}
          </IconButton>
          <IconButton label="Keyboard shortcuts" onClick={() => setHelpOpen(true)}><Keyboard size={15} /></IconButton>
          <IconButton label="Settings" active={view === 'settings'} onClick={() => go('settings')}><Settings2 size={15} /></IconButton>
        </div>
      </nav>

      <main className="main">
        <CurrentView view={view} param={route[1]} live={live} go={go} />
      </main>

      {paletteOpen && (
        <div className="palette-overlay" onMouseDown={() => setPaletteOpen(false)}>
          <Palette surface="modal" onClose={() => setPaletteOpen(false)} />
        </div>
      )}
      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

function CurrentView({ view, param, live, go }: { view: string; param?: string; live: LiveData; go: (p: string) => void }) {
  switch (view) {
    case 'tabs': return <TabsView live={live} />;
    case 'workspaces': return <WorkspacesView live={live} param={param} go={go} />;
    case 'vault': return <VaultView live={live} param={param} go={go} />;
    case 'later': return <LaterView live={live} />;
    case 'rules': return <RulesView />;
    case 'insights': return <InsightsView live={live} />;
    case 'settings': return <SettingsView />;
    default: return <TodayView live={live} go={go} />;
  }
}

function SidebarWorkspace({ id, name, active, isLive, colorStyle, badge, onOpen }: {
  id: string; name: string; active: boolean; isLive: boolean; colorStyle: CSSProperties; badge: ReactNode; onOpen: () => void;
}) {
  const [over, setOver] = useState(false);
  const toast = useToast();
  const onDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const tabs = readDraggedTabs(e);
    if (tabs.length) {
      void toast.guard(rpc('workspace.addTabs', { id, tabIds: tabs })).then((r) => reportAdded(toast, r, name));
    }
  }, [id, name, toast]);
  return (
    <button
      className={`nav-item nav-ws${active ? ' is-on' : ''}${over ? ' is-drop' : ''}`}
      style={colorStyle}
      title={name}
      onClick={onOpen}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TAB_DRAG_TYPE)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {badge}
      <span className="nav-label truncate">{name}</span>
      {isLive && <span className="dot dot-live" style={{ marginLeft: 'auto' }} title="Open in a window" />}
    </button>
  );
}

function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const browser = useMemo(() => [
    ['Open TabVault', 'Alt K'], ['Jump to previous tab', 'Alt Q'], ['Send tab to Later', 'Alt Shift S'], ['Open dashboard', 'Alt Shift D'],
  ], []);
  const inApp = [
    ['Command palette', 'Ctrl K'], ['Search', '/'], ['Go to page', 'G then H T W V L R I S'], ['This help', '?'],
  ];
  const tabs = [
    ['Move', '↑ ↓'], ['Extend selection', 'Shift ↑ ↓'], ['Select', 'Space'], ['Switch to tab', 'Enter'], ['Close', 'Del'], ['Select all', 'Ctrl A'],
  ];
  const palette = [
    ['Run', 'Enter'], ['Actions', 'Ctrl K'], ['Change scope', 'Tab'], ['Close tab', 'Del'], ['Commands', '>'],
  ];
  const col = (title: string, rows: string[][]) => (
    <div>
      <div className="section-title" style={{ marginTop: 6 }}><Command size={12} />{title}</div>
      {rows.map(([label, key]) => (
        <div className="shortcut-row" key={label}><span className="muted">{label}</span><Kbd>{key}</Kbd></div>
      ))}
    </div>
  );
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} wide>
      <div className="help-grid">
        {col('Anywhere in Chrome', browser)}
        {col('Dashboard', inApp)}
        {col('Open tabs page', tabs)}
        {col('Palette', palette)}
      </div>
      <div className="dialog-actions">
        <button className="btn" onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}>Change Chrome shortcuts</button>
        <button className="btn btn-primary" data-autofocus onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}

mount(<App />);
