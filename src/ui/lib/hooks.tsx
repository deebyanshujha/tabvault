import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_PREFS, type Prefs, type Topic, type VaultState } from '../../shared/types';
import { getPrefs, PREFS_KEY, sanitizePrefs, setPrefs } from '../../storage/prefs';
import { rpc } from './rpc';

// ---- prefs ----

export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void, boolean] {
  const [prefs, setState] = useState<Prefs>(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void getPrefs().then((p) => {
      setState(p);
      setReady(true);
    });
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[PREFS_KEY]) setState(sanitizePrefs(changes[PREFS_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);
  const update = useCallback((patch: Partial<Prefs>) => {
    setState((p) => ({ ...p, ...patch }));
    void setPrefs(patch);
  }, []);
  return [prefs, update, ready];
}

export function useTheme(theme: Prefs['theme']): void {
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
}

// ---- vault (workspaces, sessions, later, ...) ----

const EMPTY_VAULT: VaultState = {
  workspaces: [], sessions: [], sessionTabs: [], timeline: [], later: [], annotations: [], rules: [], bindings: {},
  recovery: null, trash: { workspaces: [], sessions: [] }, quarantined: 0,
};

interface VaultContextValue {
  vault: VaultState;
  loading: boolean;
  error: string | null;
  reload: () => void;
  lastTopics: Topic[];
}

const VaultContext = createContext<VaultContextValue | null>(null);

export function VaultProvider({ children }: { children: ReactNode }) {
  const [vault, setVault] = useState<VaultState>(EMPTY_VAULT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastTopics, setLastTopics] = useState<Topic[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(() => {
    rpc('vault.read', {})
      .then((state) => {
        setVault(state);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const onMessage = (message: { kind?: string; topics?: Topic[] }) => {
      if (message?.kind !== 'changed') return;
      setLastTopics(message.topics ?? []);
      clearTimeout(timer.current);
      timer.current = setTimeout(load, 80);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      chrome.runtime.onMessage.removeListener(onMessage);
      clearTimeout(timer.current);
    };
  }, [load]);

  const value = useMemo(() => ({ vault, loading, error, reload: load, lastTopics }), [vault, loading, error, load, lastTopics]);
  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault(): VaultContextValue {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error('useVault outside VaultProvider');
  return ctx;
}

// ---- live tabs ----

export interface LiveData {
  windows: chrome.windows.Window[];
  tabs: chrome.tabs.Tab[];
  groups: Map<number, chrome.tabGroups.TabGroup>;
  currentWindowId: number | undefined;
  loading: boolean;
}

const OWN_PREFIX = () => `chrome-extension://${chrome.runtime.id}/`;
export const tabUrl = (t: chrome.tabs.Tab) => t.pendingUrl || t.url || '';
export const lastAccessed = (t: chrome.tabs.Tab) => (t as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed ?? 0;

/**
 * Reads tabs directly from Chrome: instant, and it doesn't wake the worker just to
 * draw a list. Refetches on a short debounce so bursts of events cost one query.
 */
export function useLiveTabs(): LiveData {
  const [data, setData] = useState<LiveData>({ windows: [], tabs: [], groups: new Map(), currentWindowId: undefined, loading: true });
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const [windows, groups, current] = await Promise.all([
        chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
        chrome.tabGroups.query({}).catch(() => [] as chrome.tabGroups.TabGroup[]),
        chrome.windows.getCurrent().catch(() => null),
      ]);
      if (!alive) return;
      const prefix = OWN_PREFIX();
      setData({
        windows,
        tabs: windows.flatMap((w) => w.tabs ?? []).filter((t) => !tabUrl(t).startsWith(prefix)),
        groups: new Map(groups.map((g) => [g.id, g])),
        currentWindowId: current?.id,
        loading: false,
      });
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 60);
    };
    void load();
    const events = [
      chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated, chrome.tabs.onMoved, chrome.tabs.onActivated,
      chrome.tabs.onAttached, chrome.tabs.onDetached, chrome.tabs.onReplaced, chrome.windows.onCreated, chrome.windows.onRemoved,
      chrome.tabGroups.onCreated, chrome.tabGroups.onUpdated, chrome.tabGroups.onRemoved,
    ] as { addListener: (cb: () => void) => void; removeListener: (cb: () => void) => void }[];
    for (const ev of events) ev.addListener(schedule);
    return () => {
      alive = false;
      clearTimeout(timer);
      for (const ev of events) ev.removeListener(schedule);
    };
  }, []);
  return data;
}

// ---- small helpers ----

export function useDebounced<T>(value: T, ms: number): T {
  const [state, setState] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setState(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return state;
}

export function useHashRoute(): [string[], (path: string) => void] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState<string[]>(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const go = useCallback((path: string) => {
    window.location.hash = `/${path}`;
  }, []);
  return [route, go];
}
