import { listWorkspaces, addLinkToWorkspace } from './workspaces';
import { addToLater } from './later';
import { openDashboard } from './tabs';
import { saveCurrent } from './sessions';

const LATER_PAGE = 'later-page';
const LATER_LINK = 'later-link';
const SAVE_SESSION = 'save-session';
const WS_ROOT = 'ws-root';
const WS_PREFIX = 'ws:';
const OPEN_DASHBOARD = 'open-dashboard';
const OPEN_PANEL = 'open-panel';
/** Web pages only. On TabVault's own pages these would act on TabVault itself, not the row under the mouse. */
const WEB_PAGES = ['http://*/*', 'https://*/*', 'file:///*'];

let rebuilding: Promise<void> | null = null;

/** Menus persist across worker restarts: rebuild only on install and when workspaces change. */
export function rebuildMenus(): Promise<void> {
  const run = async () => {
    await chrome.contextMenus.removeAll();
    const workspaces = (await listWorkspaces()).filter((w) => !w.deletedAt).sort((a, b) => a.order - b.order);
    const create = (props: chrome.contextMenus.CreateProperties) =>
      new Promise<void>((resolve) => chrome.contextMenus.create(props, () => {
        void chrome.runtime.lastError;
        resolve();
      }));
    await create({ id: LATER_PAGE, title: 'Save page to Later', contexts: ['page'], documentUrlPatterns: WEB_PAGES });
    await create({ id: LATER_LINK, title: 'Save link to Later', contexts: ['link'], documentUrlPatterns: WEB_PAGES });
    if (workspaces.length) {
      await create({ id: WS_ROOT, title: 'Add to workspace', contexts: ['page', 'link'], documentUrlPatterns: WEB_PAGES });
      for (const ws of workspaces.slice(0, 20)) {
        await create({ id: `${WS_PREFIX}${ws.id}`, parentId: WS_ROOT, title: ws.name, contexts: ['page', 'link'], documentUrlPatterns: WEB_PAGES });
      }
    }
    await create({ id: SAVE_SESSION, title: 'Save this window to the Vault', contexts: ['page'], documentUrlPatterns: WEB_PAGES });
    await create({ id: OPEN_DASHBOARD, title: 'Open dashboard', contexts: ['action'] });
    await create({ id: OPEN_PANEL, title: 'Open side panel', contexts: ['action'] });
  };
  rebuilding = (rebuilding ?? Promise.resolve()).catch(() => undefined).then(run);
  return rebuilding;
}

export async function handleMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  const id = String(info.menuItemId);
  const url = info.linkUrl ?? info.pageUrl ?? tab?.url ?? '';
  const title = info.linkUrl ? (info.selectionText ?? info.linkUrl) : (tab?.title ?? url);
  if (id === LATER_PAGE || id === LATER_LINK) {
    await addToLater([{ url, title }]);
  } else if (id.startsWith(WS_PREFIX)) {
    await addLinkToWorkspace(id.slice(WS_PREFIX.length), url, title);
  } else if (id === SAVE_SESSION && tab?.windowId !== undefined) {
    await saveCurrent({ scope: 'window', windowId: tab.windowId });
  } else if (id === OPEN_DASHBOARD) {
    await openDashboard();
  } else if (id === OPEN_PANEL && tab?.windowId !== undefined) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
}
