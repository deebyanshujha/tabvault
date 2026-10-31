// In-memory model of the chrome.* APIs TabVault uses. Enough behaviour to exercise
// the services' logic; real-browser behaviour is covered by tests/e2e.

type Tab = chrome.tabs.Tab;

export interface FakeBrowser {
  windows: Map<number, { id: number; focused: boolean; tabs: Tab[] }>;
  groups: Map<number, { id: number; windowId: number; title: string; color: string; collapsed: boolean }>;
  session: Record<string, unknown>;
  local: Record<string, unknown>;
  alarms: Map<string, unknown>;
  sent: unknown[];
  failUrls: Set<string>;
  opened?: number;
}

const noopEvent = () => ({ addListener: () => undefined, removeListener: () => undefined, hasListener: () => false });

export function installFakeChrome(): FakeBrowser {
  let nextTabId = 100;
  let nextWindowId = 1;
  let nextGroupId = 500;
  const browser: FakeBrowser = {
    windows: new Map(), groups: new Map(), session: {}, local: {}, alarms: new Map(), sent: [], failUrls: new Set(),
  };

  const allTabs = () => [...browser.windows.values()].flatMap((w) => w.tabs);
  const reindex = (win: { tabs: Tab[] }) => win.tabs.forEach((t, i) => { t.index = i; });
  const findTab = (id: number) => {
    const tab = allTabs().find((t) => t.id === id);
    if (!tab) throw new Error(`No tab with id: ${id}`);
    return tab;
  };
  const makeTab = (windowId: number, props: Partial<Tab> & { url?: string }): Tab => {
    const url = props.url ?? 'chrome://newtab/';
    if (browser.failUrls.has(url)) throw new Error('Cannot open this address');
    return {
      id: nextTabId++, windowId, index: 0, url, title: props.title ?? url, pinned: !!props.pinned, active: !!props.active,
      highlighted: false, incognito: false, discarded: false, autoDiscardable: true, groupId: -1, selected: false, frozen: false,
      lastAccessed: Date.now(), ...props,
    } as Tab;
  };

  const storageArea = (data: () => Record<string, unknown>) => ({
    get: async (key?: string | string[]) => {
      if (key === undefined) return { ...data() };
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((k) => k in data()).map((k) => [k, structuredClone(data()[k])]));
    },
    set: async (items: Record<string, unknown>) => { Object.assign(data(), structuredClone(items)); },
    remove: async (key: string | string[]) => { for (const k of Array.isArray(key) ? key : [key]) delete data()[k]; },
  });

  const api = {
    runtime: {
      id: 'tabvaulttest',
      getURL: (p: string) => `chrome-extension://tabvaulttest/${p.replace(/^\//, '')}`,
      sendMessage: async (m: unknown) => { browser.sent.push(m); },
      onMessage: noopEvent(), onInstalled: noopEvent(), onStartup: noopEvent(),
    },
    storage: { session: storageArea(() => browser.session), local: storageArea(() => browser.local), onChanged: noopEvent() },
    alarms: {
      create: async (name: string, info: unknown) => { browser.alarms.set(name, info); },
      clear: async (name: string) => browser.alarms.delete(name),
      onAlarm: noopEvent(),
    },
    action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined },
    windows: {
      WINDOW_ID_NONE: -1,
      getAll: async ({ populate }: { populate?: boolean } = {}) =>
        [...browser.windows.values()].map((w) => ({ id: w.id, focused: w.focused, type: 'normal', tabs: populate ? w.tabs.map((t) => ({ ...t })) : undefined })),
      get: async (id: number, options: { populate?: boolean } = {}) => {
        const w = browser.windows.get(id);
        if (!w) throw new Error(`No window with id: ${id}`);
        return { id: w.id, focused: w.focused, type: 'normal', tabs: options.populate ? w.tabs.map((t) => ({ ...t })) : undefined };
      },
      getLastFocused: async () => {
        const w = [...browser.windows.values()].find((x) => x.focused) ?? [...browser.windows.values()][0];
        if (!w) throw new Error('No windows');
        return { id: w.id, focused: w.focused, type: 'normal' };
      },
      create: async ({ url, focused }: { url?: string; focused?: boolean } = {}) => {
        const id = nextWindowId++;
        const tab = makeTab(id, { url, active: true });
        browser.windows.set(id, { id, focused: !!focused, tabs: [tab] });
        return { id, focused: !!focused, tabs: [{ ...tab }] };
      },
      update: async (id: number, props: { focused?: boolean }) => {
        for (const w of browser.windows.values()) w.focused = w.id === id ? !!props.focused : false;
      },
      remove: async (id: number) => { browser.windows.delete(id); },
      onRemoved: noopEvent(), onCreated: noopEvent(), onFocusChanged: noopEvent(),
    },
    tabs: {
      query: async (q: { windowId?: number; active?: boolean } = {}) =>
        allTabs().filter((t) => (q.windowId === undefined || t.windowId === q.windowId) && (q.active === undefined || t.active === q.active)).map((t) => ({ ...t })),
      get: async (id: number) => ({ ...findTab(id) }),
      create: async (props: { windowId?: number; url?: string; pinned?: boolean; active?: boolean }) => {
        const windowId = props.windowId ?? [...browser.windows.keys()][0]!;
        const win = browser.windows.get(windowId);
        if (!win) throw new Error(`No window with id: ${windowId}`);
        const tab = makeTab(windowId, props);
        win.tabs.push(tab);
        reindex(win);
        return { ...tab };
      },
      update: async (id: number, props: Partial<Tab>) => {
        const tab = findTab(id);
        Object.assign(tab, props);
        return { ...tab };
      },
      remove: async (ids: number | number[]) => {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          for (const w of browser.windows.values()) {
            w.tabs = w.tabs.filter((t) => t.id !== id);
            reindex(w);
          }
        }
        for (const [id, w] of browser.windows) if (!w.tabs.length) browser.windows.delete(id);
      },
      discard: async (id: number) => {
        const tab = findTab(id);
        if (tab.active) throw new Error('Cannot discard active tab');
        tab.discarded = true;
        return { ...tab };
      },
      move: async (ids: number | number[], { windowId, index }: { windowId?: number; index?: number }) => {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          const tab = findTab(id);
          const from = browser.windows.get(tab.windowId)!;
          const to = browser.windows.get(windowId ?? tab.windowId);
          if (!to) throw new Error(`No window with id: ${windowId}`);
          from.tabs = from.tabs.filter((t) => t.id !== id);
          tab.windowId = to.id;
          if (index === undefined || index < 0) to.tabs.push(tab);
          else to.tabs.splice(index, 0, tab);
          reindex(from);
          reindex(to);
          if (!from.tabs.length) browser.windows.delete(from.id);
        }
      },
      reload: async () => undefined,
      group: async ({ tabIds, groupId, createProperties }: { tabIds: number[]; groupId?: number; createProperties?: { windowId?: number } }) => {
        const id = groupId ?? nextGroupId++;
        if (groupId === undefined) browser.groups.set(id, { id, windowId: createProperties?.windowId ?? -1, title: '', color: 'grey', collapsed: false });
        for (const t of tabIds) findTab(t).groupId = id;
        return id;
      },
      ungroup: async (ids: number[]) => { for (const t of ids) findTab(t).groupId = -1; },
      onCreated: noopEvent(), onUpdated: noopEvent(), onRemoved: noopEvent(), onMoved: noopEvent(), onActivated: noopEvent(),
      onAttached: noopEvent(), onDetached: noopEvent(), onReplaced: noopEvent(),
    },
    tabGroups: {
      query: async (q: { windowId?: number; title?: string } = {}) =>
        [...browser.groups.values()].filter((g) => (q.windowId === undefined || g.windowId === q.windowId) && (q.title === undefined || g.title === q.title)),
      get: async (id: number) => browser.groups.get(id),
      update: async (id: number, props: object) => { Object.assign(browser.groups.get(id)!, props); },
      onCreated: noopEvent(), onUpdated: noopEvent(), onRemoved: noopEvent(),
    },
    sessions: { getRecentlyClosed: async () => [], restore: async () => undefined },
    contextMenus: { removeAll: async () => undefined, create: (_p: unknown, cb?: () => void) => cb?.(), onClicked: noopEvent() },
    idle: { queryState: async () => 'active', setDetectionInterval: () => undefined, onStateChanged: noopEvent() },
    commands: { onCommand: noopEvent() },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = api;
  return browser;
}

export function openWindow(browser: FakeBrowser, urls: string[], focused = true): number {
  // A counter rather than the map size, so a deleted window's id is never reused.
  browser.opened = (browser.opened ?? 0) + 1;
  const id = 999 + browser.opened;
  const tabs = urls.map((url, i) => ({
    id: id * 10 + i, windowId: id, index: i, url, title: `Title of ${url}`, pinned: false, active: i === 0, groupId: -1, discarded: false,
    highlighted: false, incognito: false, autoDiscardable: true, selected: false, frozen: false, lastAccessed: Date.now(),
  } as chrome.tabs.Tab));
  browser.windows.set(id, { id, focused, tabs });
  return id;
}
