import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, launch, makeHarness, OWN, settle, startSite, test, type Harness } from './fixtures';

interface Ws { id: string; name: string; items: { id: string; url: string }[] }
interface Vault {
  workspaces: Ws[];
  sessions: { id: string; name: string; kind: string; tabCount: number }[];
  bindings: Record<string, string>;
  later: { id: string; url: string; state: string }[];
  annotations: { urlKey: string; note?: string; fromTitle?: string }[];
  recovery: { sessionId: string; missing: number } | null;
  timeline: { url: string }[];
}

test.describe('foundations', () => {
  test('loads under MV3 with a service worker and renders every page without errors', async ({ h }) => {
    const manifest = await h.worker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions ?? []).toEqual([]);
    for (const route of ['today', 'tabs', 'workspaces', 'vault', 'later', 'rules', 'insights', 'settings']) {
      const page = await h.dashboard(route);
      await expect(page.locator('h1').first()).toBeVisible();
      await page.close();
    }
    const popup = await h.popup();
    await expect(popup.locator('.palette-input')).toBeFocused();
    expect(h.errors).toEqual([]);
  });

  test('first run opens the dashboard with onboarding', async ({ h }) => {
    await expect.poll(async () => (await h.allTabs()).some((t) => t.url?.includes('dashboard.html'))).toBe(true);
    const page = await h.dashboard('today');
    await expect(page.getByText('Your browser, organized by what you’re doing')).toBeVisible();
    await page.getByRole('button', { name: 'Got it' }).click();
    await expect(page.getByText('Your browser, organized by what you’re doing')).toBeHidden();
    await page.reload();
    await expect(page.locator('.page-title')).toContainText(/tabs? open/);
    await expect(page.getByText('Your browser, organized by what you’re doing')).toBeHidden();
  });

  test('extension pages make no network requests and the CSP blocks them', async ({ h }) => {
    await h.open('alpha');
    const requests: string[] = [];
    const page = await h.context.newPage();
    page.on('request', (r) => requests.push(r.url()));
    await page.goto(`${OWN(h)}dashboard.html#/tabs`);
    await expect(page.getByText('Page alpha')).toBeVisible();
    await page.waitForTimeout(500);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((u) => !u.startsWith('chrome-extension://') && !u.startsWith('data:'))).toEqual([]);
    const blocked = await page.evaluate(() => fetch('https://example.com/').then(() => 'sent', () => 'blocked'));
    expect(blocked).toBe('blocked');
    const beacon = await page.evaluate(async (url) => {
      try {
        await fetch(url);
        return 'sent';
      } catch {
        return 'blocked';
      }
    }, h.site.url('leak'));
    expect(beacon).toBe('blocked');
    const fromWorker = await h.worker.evaluate((url) => fetch(url).then(() => 'sent', () => 'blocked'), h.site.url('leak-from-worker'));
    expect(fromWorker).toBe('blocked');
    await page.close();
    h.errors.length = 0; // the deliberately blocked requests above log CSP errors
  });

  test('a message from a web page cannot reach the worker', async ({ h }) => {
    const page = await h.open('web');
    const result = await page.evaluate(async (id) => {
      const c = (globalThis as unknown as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome;
      if (!c?.runtime?.sendMessage) return 'no-api';
      try {
        await (c.runtime.sendMessage as (id: string, m: unknown) => Promise<unknown>)(id, { kind: 'rpc', method: 'data.wipe', params: {} });
        return 'delivered';
      } catch {
        return 'rejected';
      }
    }, h.extensionId);
    expect(['no-api', 'rejected']).toContain(result);
  });

  test('state survives the service worker being killed', async ({ h }) => {
    const page = await h.open('survivor');
    const win = await page.evaluate(() => 0).then(() => h.control.evaluate(() => chrome.windows.getCurrent().then((w) => w.id!)));
    const ws = await h.rpc<Ws>('workspace.create', { name: 'Survivor', fromWindowId: win, bind: true });

    const cdp = await h.context.newCDPSession(h.control);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await h.control.waitForTimeout(800);

    // A new message wakes it, and the binding (in storage.session) is still there.
    const vault = await h.rpc<Vault>('vault.read');
    expect(vault.bindings[String(win)]).toBe(ws.id);
    expect(vault.workspaces.map((w) => w.name)).toEqual(['Survivor']);

    // And live sync still works after the restart.
    await h.open('after-restart');
    await expect.poll(async () => {
      const v = await h.rpc<Vault>('vault.read');
      return v.workspaces[0]!.items.map((i) => i.url);
    }, { timeout: 10000 }).toContain(h.site.url('after-restart'));
  });
});

test.describe('tab management', () => {
  test('lists, searches, closes and undoes', async ({ h }) => {
    await h.open('alpha');
    await h.open('beta');
    await h.open('gamma');
    const page = await h.dashboard('tabs');
    await expect(page.locator('.tab-row')).toHaveCount(3 + (await page.locator('.tab-row', { hasText: 'about:blank' }).count()));
    await page.getByLabel('Filter tabs').fill('beta');
    await expect(page.locator('.tab-row')).toHaveCount(1);
    await expect(page.locator('.tab-row')).toContainText('Page beta');
    await page.locator('.tab-row').hover();
    await page.getByRole('button', { name: 'Close tab' }).click();
    await expect(page.getByText('Closed 1 tab')).toBeVisible();
    await expect.poll(async () => (await h.allTabs()).some((t) => t.url?.includes('/beta'))).toBe(false);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await h.allTabs()).some((t) => t.url?.includes('/beta'))).toBe(true);
    expect(h.errors).toEqual([]);
  });

  test('selects several with the keyboard and bulk closes', async ({ h }) => {
    await h.open('k1');
    await h.open('k2');
    await h.open('k3');
    const page = await h.dashboard('tabs');
    await page.getByLabel('Filter tabs').fill('domain:127.0.0.1');
    await expect(page.locator('.tab-row')).toHaveCount(3);
    await page.getByLabel('Filter tabs').press('ArrowDown');
    await page.keyboard.press('Space');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.locator('.bulk-count')).toHaveText('2 selected');
    await page.locator('.bulk').getByRole('button', { name: 'Close' }).click();
    await expect.poll(async () => (await h.allTabs()).filter((t) => t.url?.startsWith('http')).length).toBe(1);
    await expect(page.locator('.bulk')).toBeHidden();
  });

  test('finds and closes duplicates, keeping one', async ({ h }) => {
    await h.open('dup');
    await h.open('dup?utm_source=mail');
    await h.open('dup#section');
    await h.open('unique');
    const page = await h.dashboard('tabs');
    await page.getByRole('button', { name: /Duplicates\s*3/ }).click();
    await expect(page.locator('.tab-row')).toHaveCount(3);
    const r = await h.rpc<{ closed: number; undoId: string }>('tabs.closeDuplicates');
    expect(r.closed).toBe(2);
    await expect.poll(async () => (await h.allTabs()).filter((t) => t.url?.includes('/dup')).length).toBe(1);
    await h.rpc('undo.run', { undoId: r.undoId });
    await expect.poll(async () => (await h.allTabs()).filter((t) => t.url?.includes('/dup')).length).toBe(3);
  });

  test('pins, groups, moves between windows and merges them back', async ({ h }) => {
    const a = await h.open('a1');
    await h.open('a2');
    const tabs = await h.allTabs();
    const ids = tabs.filter((t) => t.url?.startsWith('http')).map((t) => t.id!);

    await h.rpc('tabs.pin', { tabIds: [ids[0]], pinned: true });
    expect((await h.allTabs()).find((t) => t.id === ids[0])!.pinned).toBe(true);
    await h.rpc('tabs.pin', { tabIds: [ids[0]], pinned: false });

    const groupId = await h.rpc<number>('tabs.group', { tabIds: ids, title: 'Pair', color: 'green' });
    const group = await h.control.evaluate((g) => chrome.tabGroups.get(g), groupId);
    expect(group.title).toBe('Pair');
    expect(group.color).toBe('green');
    await h.rpc('tabs.ungroup', { tabIds: ids });

    const newWin = await h.rpc<number>('tabs.move', { tabIds: [ids[1]], target: 'new' });
    expect((await h.allTabs()).find((t) => t.id === ids[1])!.windowId).toBe(newWin);
    await a.bringToFront();
    const moved = await h.rpc<number>('tabs.mergeWindows');
    expect(moved).toBeGreaterThan(0);
    await expect.poll(async () => new Set((await h.allTabs()).map((t) => t.windowId)).size).toBe(1);
  });

  test('sleep really discards a tab and keeps its URL', async ({ h }) => {
    const page = await h.open('sleepy');
    await h.open('other');
    const id = (await h.allTabs()).find((t) => t.url?.includes('/sleepy'))!.id!;
    expect(await h.rpc<number>('tabs.sleep', { tabIds: [id] })).toBe(1);
    const tab = await h.control.evaluate((i) => chrome.tabs.get(i), id).catch(async () => (await h.allTabs()).find((t) => t.url?.includes('/sleepy'))!);
    expect(tab.discarded).toBe(true);
    expect(tab.url).toContain('/sleepy');
    expect(page).toBeTruthy();
  });

  test('group by site and sort use real Chrome tab groups', async ({ h }) => {
    await h.open('s1');
    await h.open('s2');
    const win = (await h.allTabs()).find((t) => t.url?.startsWith('http'))!.windowId;
    const r = await h.rpc<{ groups: number; tabs: number }>('tabs.organize', { windowId: win });
    expect(r.groups).toBe(1);
    const groups = await h.control.evaluate(() => chrome.tabGroups.query({}));
    expect(groups[0]!.title).toBe('127.0.0.1');
    await h.rpc('tabs.sort', { windowId: win, by: 'title' });
  });

  test('sorting keeps every tab', async ({ h }) => {
    await h.open('zebra');
    await h.open('apple');
    await h.open('mango');
    const win = (await h.allTabs()).find((t) => t.url?.startsWith('http'))!.windowId;
    const before = (await h.allTabs()).length;
    await h.rpc('tabs.sort', { windowId: win, by: 'title' });
    const after = await h.control.evaluate((w) => chrome.tabs.query({ windowId: w }), win);
    expect((await h.allTabs()).length).toBe(before);
    const titled = after.filter((t) => t.url?.startsWith('http')).map((t) => t.title);
    expect(titled).toEqual(['Page apple', 'Page mango', 'Page zebra']);
  });

  test('remembers which page opened a tab', async ({ h }) => {
    const page = await h.open('parent');
    await page.bringToFront();
    const [child] = await Promise.all([h.context.waitForEvent('page'), page.click('#link')]);
    await child.waitForLoadState();
    await expect.poll(async () => {
      const v = await h.rpc<Vault>('vault.read');
      return v.annotations.find((a) => a.urlKey.includes('child-of-parent'))?.fromTitle;
    }).toBe('Page parent');
  });

  test('a page reached from a blank new tab is not credited to the previous tab', async ({ h }) => {
    const previous = await h.open('previous-tab');
    await previous.bringToFront();
    await h.open('typed-address');
    await h.control.waitForTimeout(800);
    const vault = await h.rpc<Vault>('vault.read');
    expect(vault.annotations.find((a) => a.urlKey.includes('typed-address'))?.fromTitle).toBeUndefined();
  });
});

test.describe('popup while a real page is the active tab', () => {
  // chrome.action.openPopup() surfaces no page in headless Chromium. Keeping popup.html in a
  // background tab gives the same situation the real popup sees: a website is the active tab.
  const openPopupBehind = async (h: Harness, current: Page) => {
    const popup = await h.popup();
    await current.bringToFront();
    await expect(popup.locator('.section-row').first()).toHaveText('Current tab');
    return popup;
  };

  test('lists the current tab first, hides empty tabs, and labels other windows', async ({ h }) => {
    await h.open('older-page');
    await h.control.evaluate(() => chrome.tabs.create({ url: 'chrome://newtab/', active: false }));
    await h.control.evaluate((url) => chrome.windows.create({ url, focused: false }), h.site.url('far-away'));
    const current = await h.open('current-site');
    await current.bringToFront();
    const popup = await openPopupBehind(h, current);

    await expect(popup.locator('.result').first()).toContainText('Page current-site');
    await expect(popup.locator('.result', { hasText: 'Page older-page' })).toBeVisible();
    await expect(popup.locator('.result', { hasText: 'New Tab' })).toHaveCount(0);
    const far = popup.locator('.result', { hasText: 'Page far-away' });
    await expect(far).toContainText('Other window');

    // Searching still finds an empty tab, and the Tabs scope still lists it.
    await popup.getByRole('tab', { name: /Tabs/ }).click();
    await expect(popup.locator('.result', { hasText: 'New Tab' })).toHaveCount(1);
    expect(h.errors).toEqual([]);
  });

  test('right-clicking a row acts on that row, not on TabVault', async ({ h }) => {
    const ws = await h.rpc<Ws>('workspace.create', { name: 'Fun' });
    await h.open('some-other-page');
    const current = await h.open('add-me');
    await current.bringToFront();
    const popup = await openPopupBehind(h, current);
    const items = async () => (await h.rpc<Vault>('vault.read')).workspaces.find((w) => w.id === ws.id)!.items.map((t) => t.url);

    await popup.locator('.result', { hasText: 'Page some-other-page' }).click({ button: 'right' });
    const menu = popup.locator('.context-menu');
    await expect(menu).toBeVisible();
    // The menu fits in the window and the row didn't run its main action.
    const box = (await menu.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(popup.viewportSize()!.height);

    await menu.getByRole('menuitem', { name: 'Add to Fun' }).click();
    await expect.poll(items).toEqual([h.site.url('some-other-page')]);
    await expect(menu).toHaveCount(0);

    // Clicking away closes it without also switching to the row underneath.
    await popup.locator('.result', { hasText: 'Page add-me' }).click({ button: 'right' });
    await popup.locator('.context-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(popup.locator('.context-menu')).toHaveCount(0);
    expect(await current.evaluate(() => document.visibilityState)).toBe('visible');
    expect(h.errors).toEqual([]);
  });

  test('right-clicking a row on the Open tabs page adds that tab', async ({ h }) => {
    const ws = await h.rpc<Ws>('workspace.create', { name: 'Fun' });
    await h.open('from-dashboard');
    const page = await h.dashboard('tabs');
    await page.locator('.tab-row', { hasText: 'Page from-dashboard' }).click({ button: 'right' });
    await page.locator('.context-menu').getByRole('menuitem', { name: 'Add to Fun' }).click();
    await expect.poll(async () => (await h.rpc<Vault>('vault.read')).workspaces.find((w) => w.id === ws.id)!.items.map((t) => t.url)).toEqual([h.site.url('from-dashboard')]);
    expect(h.errors).toEqual([]);
  });

  test('adds the current tab to a live workspace, and it stays added', async ({ h }) => {
    const liveWin = await h.control.evaluate((url) => chrome.windows.create({ url, focused: false }).then((w) => w!.id!), h.site.url('already-there'));
    await h.control.waitForTimeout(500);
    const ws = await h.rpc<Ws>('workspace.create', { name: 'Fun', fromWindowId: liveWin, bind: true });
    await h.open('keeps-window-open');
    const current = await h.open('add-this-one');
    await current.bringToFront();
    const popup = await openPopupBehind(h, current);

    await expect(popup.locator('.result').first()).toContainText('Page add-this-one');
    await popup.locator('.palette-input').press('Control+k');
    await popup.getByRole('menuitem', { name: 'Add to Fun' }).click();
    await expect(popup.getByText('Moved 1 tab to Fun’s window')).toBeVisible();

    const urls = () => h.rpc<Vault>('vault.read').then((v) => v.workspaces.find((w) => w.id === ws.id)!.items.map((i) => i.url));
    await expect.poll(urls).toContain(h.site.url('add-this-one'));
    // Past the sync debounce: this is what used to wipe it.
    await h.control.waitForTimeout(2500);
    expect(await urls()).toContain(h.site.url('add-this-one'));
    const tab = (await h.allTabs()).find((t) => t.url?.includes('/add-this-one'))!;
    expect(tab.windowId).toBe(liveWin);
    expect(h.errors).toEqual([]);
  });
});

test.describe('palette', () => {
  test('finds tabs instantly, runs commands, and is keyboard driven', async ({ h }) => {
    await h.open('needle');
    await h.open('haystack');
    await h.rpc('workspace.create', { name: 'Thesis', links: [{ url: h.site.url('in-workspace'), title: 'Saved source' }] });
    const popup = await h.popup();
    const input = popup.locator('.palette-input');

    await input.fill('needle');
    await expect(popup.locator('.result').first()).toContainText('Page needle');

    await input.fill('thesis');
    await expect(popup.locator('.result').first()).toContainText('Thesis');

    await input.fill('saved source');
    await expect(popup.locator('.result').first()).toContainText('Saved source');

    await input.fill('domain:127.0.0.1 in:tabs');
    await expect(popup.locator('.result')).toHaveCount(2);

    await input.fill('zzzqqq');
    await expect(popup.getByText('Nothing matches “zzzqqq”')).toBeVisible();

    await input.fill('> duplicate');
    await expect(popup.locator('.result').first()).toContainText('Close duplicate tabs');
    await input.press('Enter');
    await expect(popup.getByText(/No duplicate tabs/)).toBeVisible();

    // Actions panel
    await input.fill('needle');
    await expect(popup.locator('.result').first()).toContainText('Page needle');
    await input.press('Control+k');
    await expect(popup.getByRole('menu')).toBeVisible();
    await expect(popup.getByRole('menuitem', { name: 'Send to Later' })).toBeVisible();
    await popup.keyboard.press('Escape');
    await expect(popup.getByRole('menu')).toBeHidden();
    await expect(input).toBeFocused();

    // Tab cycles scope; Escape clears then resets
    await input.fill('');
    await input.press('Tab');
    await expect(popup.getByRole('tab', { name: /Tabs/ })).toHaveAttribute('aria-selected', 'true');
    await input.press('Escape');
    await expect(popup.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    expect(h.errors).toEqual([]);
  });

  test('Enter switches to a tab, Delete closes one', async ({ h }) => {
    await h.open('target');
    await h.open('victim');
    const popup = await h.popup();
    const input = popup.locator('.palette-input');
    await input.fill('victim');
    await expect(popup.locator('.result').first()).toContainText('Page victim');
    await input.press('Delete');
    await expect(popup.getByText('Closed 1 tab')).toBeVisible();
    await expect.poll(async () => (await h.allTabs()).some((t) => t.url?.includes('/victim'))).toBe(false);

    await input.fill('target');
    await expect(popup.locator('.result').first()).toContainText('Page target');
    const closed = popup.waitForEvent('close').catch(() => undefined);
    await input.press('Enter');
    await closed;
    const active = (await h.allTabs()).find((t) => t.url?.includes('/target'))!;
    expect(active.active).toBe(true);
  });

  test('side panel lists tabs by window', async ({ h }) => {
    await h.open('panel-tab');
    const page = await h.context.newPage();
    await page.goto(`${OWN(h)}sidepanel.html`);
    await expect(page.locator('.result', { hasText: 'Page panel-tab' })).toBeVisible();
    await expect(page.locator('.section-row').first()).toBeVisible();
  });
});

test.describe('dialogs and modal palette', () => {
  test('Ctrl+K opens a centered palette that searches, and Escape closes it', async ({ h }) => {
    await h.open('modal-target');
    const page = await h.dashboard('today');
    await page.keyboard.press('Control+k');
    const palette = page.locator('.palette');
    await expect(palette).toBeVisible();
    await expect(page.locator('.palette-input')).toBeFocused();
    const box = (await palette.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(2);
    expect(box.height).toBeGreaterThan(300);
    await page.keyboard.type('modal-target');
    const result = page.locator('.result').first();
    await expect(result).toContainText('Page modal-target');
    await expect(result).toBeVisible();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    expect(h.errors).toEqual([]);
  });

  test('dialogs focus their main field; Enter submits and Escape cancels', async ({ h }) => {
    const page = await h.dashboard('workspaces/new');
    const name = page.getByLabel('Name');
    await expect(name).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.goto(`${OWN(h)}dashboard.html#/workspaces/new`);
    await expect(name).toBeFocused();
    await page.keyboard.type('Typed name');
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Workspace name')).toHaveValue('Typed name');
  });

  test('broad search shows one row per page, a scoped search shows the saved copy', async ({ h }) => {
    await h.open('once-only');
    await h.rpc('session.save', { scope: 'all', name: 'Holds a copy' });
    const popup = await h.popup();
    const input = popup.locator('.palette-input');
    await input.fill('once-only');
    await expect(popup.locator('.result').first()).toContainText('Page once-only');
    await expect(popup.locator('.result')).toHaveCount(1);
    await input.fill('once-only in:sessions');
    await expect(popup.locator('.result').first()).toContainText('Holds a copy');
  });
});

test.describe('workspaces', () => {
  test('creates through the UI, from a template', async ({ h }) => {
    const page = await h.dashboard('workspaces');
    await page.getByRole('button', { name: 'New workspace' }).first().click();
    await page.getByRole('button', { name: 'Interview prep' }).click();
    await expect(page.getByLabel('Name')).toHaveValue('Interview prep');
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByLabel('Workspace name')).toHaveValue('Interview prep');
    const vault = await h.rpc<Vault>('vault.read');
    expect(vault.workspaces[0]).toMatchObject({ name: 'Interview prep' });
    expect(vault.workspaces[0]!.items[0]!.url).toContain('leetcode');
    expect(h.errors).toEqual([]);
  });

  test('renames, recolours, deletes with confirm, and undoes', async ({ h }) => {
    const ws = await h.rpc<Ws>('workspace.create', { name: 'Before' });
    const page = await h.dashboard(`workspaces/${ws.id}`);
    const name = page.getByLabel('Workspace name');
    await name.fill('After');
    await name.press('Enter');
    await expect.poll(async () => (await h.rpc<Vault>('vault.read')).workspaces[0]!.name).toBe('After');

    await page.getByRole('button', { name: 'Change colour and icon' }).click();
    await page.getByRole('radio', { name: 'purple' }).click();
    await page.getByRole('radio', { name: 'rocket' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect.poll(async () => (await h.rpc<{ workspaces: { color: string; icon: string }[] }>('vault.read')).workspaces[0]).toMatchObject({ color: 'purple', icon: 'rocket' });

    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete workspace' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText('Deleted After')).toBeVisible();
    expect((await h.rpc<Vault>('vault.read')).workspaces).toEqual([]);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await h.rpc<Vault>('vault.read')).workspaces.length).toBe(1);
    expect(h.errors).toEqual([]);
  });

  test('a bound window saves itself as tabs change', async ({ h }) => {
    const page = await h.open('one');
    const win = await page.evaluate(() => 0).then(async () => (await h.allTabs()).find((t) => t.url?.includes('/one'))!.windowId);
    const ws = await h.rpc<Ws>('workspace.create', { name: 'Live', fromWindowId: win, bind: true });
    await h.open('two');
    await expect.poll(async () => (await h.rpc<Vault>('vault.read')).workspaces[0]!.items.map((i) => i.url), { timeout: 10000 }).toContain(h.site.url('two'));
    const two = (await h.allTabs()).find((t) => t.url?.includes('/two'))!;
    await h.control.evaluate((i) => chrome.tabs.remove(i), two.id!);
    await expect.poll(async () => (await h.rpc<Vault>('vault.read')).workspaces[0]!.items.map((i) => i.url), { timeout: 10000 }).not.toContain(h.site.url('two'));
    expect(ws.id).toBeTruthy();
  });

  test('switching a window round-trips with no tab lost', async ({ h }) => {
    await h.open('work-a');
    await h.open('work-b');
    const win = (await h.allTabs()).find((t) => t.url?.includes('/work-a'))!.windowId;
    const reading = await h.rpc<Ws>('workspace.create', { name: 'Reading', links: [{ url: h.site.url('read-1'), title: 'R1' }, { url: h.site.url('read-2'), title: 'R2' }] });

    const result = await h.rpc<{ parkedCount: number; parkedSessionId: string }>('workspace.open', { id: reading.id, mode: 'replace', windowId: win });
    expect(result.parkedCount).toBeGreaterThanOrEqual(2);

    await expect.poll(async () => (await h.control.evaluate((w) => chrome.tabs.query({ windowId: w }), win)).map((t) => t.pendingUrl || t.url).filter((u) => u?.startsWith('http')).sort())
      .toEqual([h.site.url('read-1'), h.site.url('read-2')]);

    const parked = await h.rpc<{ windows: { tabs: { url: string }[] }[] }>('session.get', { id: result.parkedSessionId });
    expect(parked.windows.flatMap((w) => w.tabs.map((t) => t.url))).toEqual(expect.arrayContaining([h.site.url('work-a'), h.site.url('work-b')]));
    const restored = await h.rpc<{ opened: number }>('session.restore', { id: result.parkedSessionId, mode: 'current-window', windowId: win });
    expect(restored.opened).toBeGreaterThanOrEqual(2);
  });

  test('opens in a new window, then focuses it rather than duplicating', async ({ h }) => {
    const ws = await h.rpc<Ws>('workspace.create', { name: 'W', links: [{ url: h.site.url('w1'), title: 'W1' }, { url: h.site.url('w2'), title: 'W2' }] });
    const before = new Set((await h.allTabs()).map((t) => t.windowId)).size;
    const first = await h.rpc<{ windowIds: number[]; opened: number; focusedExisting: boolean }>('workspace.open', { id: ws.id, mode: 'new-window' });
    expect(first.opened).toBe(2);
    expect(new Set((await h.allTabs()).map((t) => t.windowId)).size).toBe(before + 1);
    const second = await h.rpc<{ focusedExisting: boolean }>('workspace.open', { id: ws.id, mode: 'new-window' });
    expect(second.focusedExisting).toBe(true);
    expect(new Set((await h.allTabs()).map((t) => t.windowId)).size).toBe(before + 1);
  });

  test('dragging a tab onto a workspace in the sidebar adds it', async ({ h }) => {
    await h.open('draggable');
    const ws = await h.rpc<Ws>('workspace.create', { name: 'Drop here' });
    const page = await h.dashboard('tabs');
    const row = page.locator('.tab-row', { hasText: 'Page draggable' });
    await row.dragTo(page.locator('.nav-ws', { hasText: 'Drop here' }));
    await expect(page.getByText('Added 1 tab to Drop here')).toBeVisible();
    const vault = await h.rpc<Vault>('vault.read');
    expect(vault.workspaces.find((w) => w.id === ws.id)!.items[0]!.url).toBe(h.site.url('draggable'));
  });

  test('reordering a live workspace reorders its real tabs and survives sync', async ({ h }) => {
    const win = await h.control.evaluate((urls) => chrome.windows.create({ url: urls }).then((w) => w!.id!), ['x', 'y', 'z'].map((n) => h.site.url(n)));
    await h.control.waitForTimeout(800);
    const ws = await h.rpc<Ws>('workspace.create', { name: 'Live order', fromWindowId: win, bind: true });
    const [x, y, z] = ws.items;
    await h.rpc('workspace.reorderItems', { id: ws.id, itemIds: [z!.id, x!.id, y!.id] });
    const order = () => h.control.evaluate((w) => chrome.tabs.query({ windowId: w }).then((t) => t.map((i) => i.url!.split('/').pop())), win);
    await expect.poll(order).toEqual(['z', 'x', 'y']);
    await h.control.waitForTimeout(2200);
    expect((await h.rpc<Vault>('vault.read')).workspaces[0]!.items.map((i) => i.url.split('/').pop())).toEqual(['z', 'x', 'y']);
  });

  test('reordering items by drag persists', async ({ h }) => {
    const ws = await h.rpc<Ws>('workspace.create', { name: 'Order', links: ['a', 'b', 'c'].map((n) => ({ url: h.site.url(n), title: n })) });
    const page = await h.dashboard(`workspaces/${ws.id}`);
    const rows = page.locator('.card.list .lrow');
    await rows.nth(2).dragTo(rows.nth(0));
    await expect.poll(async () => (await h.rpc<Vault>('vault.read')).workspaces[0]!.items.map((i) => i.url.split('/').pop())).toEqual(['c', 'a', 'b']);
  });
});

test.describe('session vault', () => {
  test('saves, previews, and restores only the tabs you pick', async ({ h }) => {
    await h.open('keep-1');
    await h.open('keep-2');
    await h.open('keep-3');
    const page = await h.dashboard('vault');
    await expect(page.getByText('Nothing saved yet')).toBeVisible();
    await page.getByRole('button', { name: 'Save session' }).click();
    await page.getByLabel(/Name/).fill('My research');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'My research' })).toBeVisible();

    await page.getByLabel('Select Page keep-2').check();
    await expect(page.getByRole('button', { name: 'Restore 1 tab' })).toBeVisible();

    for (const t of await h.allTabs()) {
      if (t.url?.includes('/keep-')) await h.control.evaluate((i) => chrome.tabs.remove(i), t.id!);
    }
    await page.getByRole('button', { name: 'Restore 1 tab' }).click();
    await expect.poll(async () => (await h.allTabs()).filter((t) => (t.pendingUrl || t.url)?.includes('/keep-')).map((t) => t.pendingUrl || t.url)).toEqual([h.site.url('keep-2')]);
    expect(h.errors).toEqual([]);
  });

  test('restores tab groups into a new window', async ({ h }) => {
    await h.open('g1');
    await h.open('g2');
    const ids = (await h.allTabs()).filter((t) => t.url?.startsWith('http')).map((t) => t.id!);
    await h.rpc('tabs.group', { tabIds: ids, title: 'Restored group', color: 'red' });
    const session = await h.rpc<{ id: string }>('session.save', { scope: 'tabs', tabIds: ids, name: 'Grouped' });
    await h.rpc('tabs.close', { tabIds: ids });
    const result = await h.rpc<{ opened: number; windowIds: number[] }>('session.restore', { id: session.id, mode: 'new-windows' });
    expect(result.opened).toBe(2);
    await expect.poll(async () => (await h.control.evaluate(() => chrome.tabGroups.query({}))).map((g) => g.title)).toContain('Restored group');
  });

  test('restoring a big set puts background tabs to sleep with URLs intact', async ({ h }) => {
    const links = Array.from({ length: 8 }, (_, i) => ({ url: h.site.url(`big-${i}`), title: `Big ${i}` }));
    const ws = await h.rpc<Ws>('workspace.create', { name: 'Big', links });
    await h.rpc('workspace.open', { id: ws.id, mode: 'new-window' });
    await expect.poll(async () => (await h.allTabs()).filter((t) => t.url?.includes('/big-') && t.discarded).length, { timeout: 20000 }).toBe(7);
    const urls = (await h.allTabs()).filter((t) => t.url?.includes('/big-')).map((t) => t.url);
    expect(new Set(urls).size).toBe(8);
  });

  test('deleted sessions go to Trash and come back', async ({ h }) => {
    await h.open('t1');
    const session = await h.rpc<{ id: string; name: string }>('session.save', { scope: 'all', name: 'Trash me' });
    const page = await h.dashboard(`vault/${session.id}`);
    await page.getByRole('button', { name: 'More session options' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByText('Session deleted')).toBeVisible();
    await page.goto(`${OWN(h)}dashboard.html#/settings`);
    await expect(page.getByText('Trash me')).toBeVisible();
    await page.locator('.lrow', { hasText: 'Trash me' }).getByRole('button', { name: 'Restore' }).click();
    await expect.poll(async () => (await h.rpc<Vault>('vault.read')).sessions.some((s) => s.id === session.id)).toBe(true);
  });

  test('snapshots feed the Time Machine and are searchable after closing', async ({ h }) => {
    const page = await h.open('forgotten-article');
    await settle(h.control);
    const snap = await h.rpc<{ id: string } | null>('session.snapshotNow');
    expect(snap).not.toBeNull();
    expect(await h.rpc('session.snapshotNow')).toBeNull();
    await page.close();
    const popup = await h.popup();
    const input = popup.locator('.palette-input');
    await input.fill('forgotten-article');
    await expect(popup.locator('.result').first()).toContainText('Page forgotten-article');
    await expect(popup.locator('.result').first()).toContainText(/Time Machine|Closed/);
  });

  test('closing a window saves it to the Vault', async ({ h }) => {
    const ws = await h.rpc<{ windowIds: number[] }>('session.save', { scope: 'all', name: 'noop' }).catch(() => null);
    expect(ws).toBeDefined();
    const win = await h.control.evaluate((urls) => chrome.windows.create({ url: urls }), [h.site.url('cw1'), h.site.url('cw2')]);
    await settle(h.control);
    await h.control.evaluate((id) => chrome.windows.remove(id), win!.id!);
    await expect.poll(async () => (await h.rpc<Vault>('vault.read')).sessions.filter((s) => s.kind === 'closed-window').map((s) => s.tabCount), { timeout: 10000 }).toEqual([2]);
  });
});

test.describe('later', () => {
  test('saves a tab, closes it, opens it again', async ({ h }) => {
    await h.open('read-me');
    const tab = (await h.allTabs()).find((t) => t.url?.includes('/read-me'))!;
    const r = await h.rpc<{ added: number; itemIds: string[] }>('later.addTabs', { tabIds: [tab.id], close: true });
    expect(r.added).toBe(1);
    await expect.poll(async () => (await h.allTabs()).some((t) => t.url?.includes('/read-me'))).toBe(false);
    const page = await h.dashboard('later');
    const row = page.locator('.lrow', { hasText: 'Page read-me' });
    await expect(row).toBeVisible();
    await row.locator('.lrow-body').click();
    await expect.poll(async () => (await h.allTabs()).some((t) => (t.pendingUrl || t.url)?.includes('/read-me'))).toBe(true);
    await expect.poll(async () => (await h.rpc<Vault>('vault.read')).later[0]!.state).toBe('done');
  });

  test('a snoozed tab comes back by itself', async ({ h }) => {
    await h.open('anchor');
    await h.rpc('later.addLink', { url: h.site.url('snoozed'), title: 'Snoozed', snoozeUntil: Date.now() + 1500 });
    // Chrome enforces a minimum alarm delay, so this can take up to about a minute.
    await expect.poll(async () => (await h.allTabs()).some((t) => (t.pendingUrl || t.url)?.includes('/snoozed')), { timeout: 75000, intervals: [2000] }).toBe(true);
  });
});

test.describe('rules', () => {
  test('auto-groups new tabs and respects toggling off', async ({ h }) => {
    const rule = await h.rpc<{ id: string; match: object; action: object }>('rule.save', { match: { kind: 'url-contains', value: 'work-' }, action: { type: 'group', title: 'Work', color: 'blue' } });
    await h.open('work-1');
    await expect.poll(async () => (await h.control.evaluate(() => chrome.tabGroups.query({}))).map((g) => g.title)).toContain('Work');
    await h.open('work-2');
    await expect.poll(async () => {
      const groups = await h.control.evaluate(() => chrome.tabGroups.query({}));
      const tabs = (await h.allTabs()).filter((t) => t.url?.includes('/work-'));
      return { groupCount: groups.length, sameGroup: tabs.length === 2 && tabs[0]!.groupId === tabs[1]!.groupId && tabs[0]!.groupId > 0 };
    }).toEqual({ groupCount: 1, sameGroup: true });

    await h.rpc('rule.save', { id: rule.id, enabled: false, match: rule.match, action: rule.action });
    await h.open('work-3');
    await h.control.waitForTimeout(800);
    const third = (await h.allTabs()).find((t) => t.url?.includes('/work-3'))!;
    expect(third.groupId).toBe(-1);
  });

  test('creates a rule through the UI', async ({ h }) => {
    const page = await h.dashboard('rules');
    await page.getByRole('button', { name: 'New rule' }).click();
    await page.getByLabel('Value').fill('example.org');
    await page.getByLabel('Group name').fill('Examples');
    await page.getByRole('button', { name: 'Create rule' }).click();
    await expect(page.getByText('When site is example.org, group as “Examples”')).toBeVisible();
    expect(h.errors).toEqual([]);
  });
});

test.describe('data', () => {
  test('exports a backup and imports it into a fresh state', async ({ h }) => {
    await h.rpc('workspace.create', { name: 'Backed up', links: [{ url: h.site.url('b'), title: 'B' }] });
    const page = await h.dashboard('settings');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export' }).click();
    const download = await downloadPromise;
    const path = await download.path();
    expect(download.suggestedFilename()).toMatch(/^tabvault-backup-.*\.json$/);

    await h.rpc('data.wipe');
    await expect.poll(async () => (await h.rpc<Vault>('vault.read')).workspaces.length).toBe(0);

    await page.getByLabel('Backup file').setInputFiles(path);
    await expect(page.getByText(/Imported 1 workspace/)).toBeVisible();
    expect((await h.rpc<Vault>('vault.read')).workspaces[0]!.name).toBe('Backed up');
    expect(h.errors).toEqual([]);
  });

  test('a malformed backup is refused with a clear message and changes nothing', async ({ h }) => {
    await h.rpc('workspace.create', { name: 'Untouched' });
    const file = join(mkdtempSync(join(tmpdir(), 'tv-')), 'bad.json');
    writeFileSync(file, '{"format":"nope"}');
    const page = await h.dashboard('settings');
    await page.getByLabel('Backup file').setInputFiles(file);
    await expect(page.getByText('That isn’t a TabVault backup file.')).toBeVisible();
    expect((await h.rpc<Vault>('vault.read')).workspaces.map((w) => w.name)).toEqual(['Untouched']);
  });

  test('imports a OneTab list through the UI', async ({ h }) => {
    const page = await h.dashboard('settings');
    await page.getByRole('button', { name: 'Paste links' }).click();
    await page.getByRole('textbox', { name: 'Links' }).fill(`${h.site.url('imp1')} | First\n${h.site.url('imp2')}\njavascript:alert(1) | evil`);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByText(/Imported 2 links into the Vault\. 1 line ignored/)).toBeVisible();
  });

  test('corrupt stored records are quarantined and the UI keeps working', async ({ h }) => {
    await h.rpc('workspace.create', { name: 'Healthy' });
    await h.control.evaluate(() => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('tabvault');
      open.onsuccess = () => {
        const tx = open.result.transaction('workspaces', 'readwrite');
        tx.objectStore('workspaces').put({ id: 'broken', name: 42, items: 'nope' });
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    }));
    const page = await h.dashboard('settings');
    await expect(page.getByText('Unreadable records')).toBeVisible();
    await page.goto(`${OWN(h)}dashboard.html#/workspaces`);
    await expect(page.locator('.ws-card', { hasText: 'Healthy' })).toBeVisible();
    expect((await h.rpc<Vault>('vault.read')).workspaces.map((w) => w.name)).toEqual(['Healthy']);
    expect(h.errors).toEqual([]);
  });
});

test.describe('scale', () => {
  test('stays fast with 300 open tabs', async ({ h }) => {
    await h.control.evaluate(async (urls) => {
      for (const url of urls) await chrome.tabs.create({ url, active: false });
    }, Array.from({ length: 300 }, (_, i) => h.site.url(`bulk-${i}`)));
    await settle(h.control, 2500);

    const page = await h.dashboard('tabs');
    await expect(page.locator('.tab-row').first()).toBeVisible();
    // Virtualized: a full page of DOM rows, not 300.
    expect(await page.locator('.tab-row').count()).toBeLessThan(60);
    const filter = page.getByLabel('Filter tabs');
    const t0 = Date.now();
    await filter.fill('bulk-299');
    await expect(page.locator('.tab-row')).toHaveCount(1);
    expect(Date.now() - t0).toBeLessThan(1500);
    await filter.fill('');

    // Scrolling reaches the end.
    await page.locator('.vlist').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(page.locator('.tab-row', { hasText: 'Page bulk-299' })).toBeVisible();

    const started = Date.now();
    const popup = await h.popup();
    await expect(popup.locator('.result').first()).toBeVisible();
    const openMs = Date.now() - started;
    console.log(`popup with 300 tabs usable in ${openMs}ms`);
    expect(openMs).toBeLessThan(3000);
    await popup.locator('.palette-input').fill('bulk-150');
    await expect(popup.locator('.result').first()).toContainText('Page bulk-150');
    expect(h.errors).toEqual([]);
  });
});

test.describe('browser restart', () => {
  test('offers to recover tabs that did not come back, and re-binds a workspace whose tabs did', async () => {
    test.setTimeout(150_000);
    const profile = mkdtempSync(join(tmpdir(), 'tabvault-restart-'));
    const site = await startSite();
    try {
      const first = await launch(profile);
      const h1 = await makeHarness(first.context, first.worker, first.extensionId, site, profile);
      await h1.open('lost-1');
      await h1.open('lost-2');
      await h1.open('lost-3');
      const liveWin = await h1.control.evaluate((urls) => chrome.windows.create({ url: urls }).then((w) => w!.id!), [site.url('live-1'), site.url('live-2')]);
      await h1.control.waitForTimeout(500);
      const liveWs = await h1.rpc<Ws>('workspace.create', { name: 'Comes back', fromWindowId: liveWin, bind: true });
      await expect.poll(async () => {
        const live = await h1.control.evaluate(() => new Promise<{ windows?: { tabs: { url: string }[] }[] } | undefined>((resolve) => {
          const open = indexedDB.open('tabvault');
          open.onsuccess = () => {
            const req = open.result.transaction('kv').objectStore('kv').get('liveState');
            req.onsuccess = () => { open.result.close(); resolve(req.result); };
          };
        }));
        return live?.windows?.flatMap((w) => w.tabs.map((t) => t.url)).filter((u) => u.includes('/lost-')).length;
      }, { timeout: 10000 }).toBe(3);
      await first.context.close();

      const second = await launch(profile);
      const h2 = await makeHarness(second.context, second.worker, second.extensionId, site, profile);
      // As Chrome's session restore would: the workspace's tabs reappear in a new window.
      const reborn = await h2.control.evaluate((urls) => chrome.windows.create({ url: urls }).then((w) => w!.id!), [site.url('live-1'), site.url('live-2')]);
      await expect.poll(async () => (await h2.rpc<Vault>('vault.read')).bindings[String(reborn)], { timeout: 60000, intervals: [2000] }).toBe(liveWs.id);
      // The check waits 30s so Chrome's own session restore can finish first.
      await expect.poll(async () => (await h2.rpc<Vault>('vault.read')).recovery?.missing, { timeout: 60000, intervals: [2000] }).toBeGreaterThanOrEqual(3);
      const page = await h2.dashboard('today');
      await expect(page.getByText(/didn’t come back after the restart/)).toBeVisible();
      await expect.poll(() => h2.worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('!');
      await page.getByRole('button', { name: 'Restore', exact: true }).click();
      await expect.poll(async () => (await h2.allTabs()).filter((t) => (t.pendingUrl || t.url)?.includes('/lost-')).length, { timeout: 20000 }).toBe(3);
      await expect(page.getByText(/didn’t come back after the restart/)).toBeHidden();
      await expect.poll(() => h2.worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('');
      await second.context.close();
    } finally {
      site.server.close();
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });
});

test.describe('insights and motion', () => {
  const seed = (page: Page) => page.evaluate(async () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const d = new Date();
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const db = await new Promise<IDBDatabase>((done, fail) => {
      const r = indexedDB.open('tabvault');
      r.onsuccess = () => done(r.result);
      r.onerror = () => fail(r.error);
    });
    const tx = db.transaction('activity', 'readwrite');
    tx.objectStore('activity').put({
      day,
      focusSeconds: { 'a.test': 5400, 'b.test': 1800, 'c.test': 900, 'd.test': 600, 'e.test': 300, 'f.test': 120, 'g.test': 60 },
      hours: { 10: 5000, 15: 4180 }, switches: 40, longest: { domain: 'a.test', seconds: 2700 }, opened: 12, closed: 7, peakTabs: 19,
    });
    await new Promise((done) => { tx.oncomplete = done; });
    db.close();
  });

  test('shows the share of time by site, with the rest folded into Other', async ({ h }) => {
    const page = await h.dashboard('insights');
    await seed(page);
    await page.reload();

    await expect(page.locator('.donut circle')).toHaveCount(6);
    await expect(page.locator('.legend-row')).toHaveCount(6);
    await expect(page.locator('.legend-row').first()).toContainText('a.test');
    await expect(page.locator('.legend-row').first()).toContainText('59%');
    await expect(page.locator('.legend-row').last()).toContainText('2 other sites');
    await expect(page.locator('.donut')).toHaveAttribute('aria-label', /a\.test 59%/);
    // The ring really draws: arcs add up to the whole circle once the sweep has run.
    await expect.poll(() => page.locator('.donut circle').evaluateAll((els) => els.reduce((n, el) => n + parseFloat(getComputedStyle(el).strokeDasharray), 0))).toBeGreaterThan(95);

    await page.locator('.legend-row').first().hover();
    await expect(page.locator('.donut-value')).toHaveText('59%');
    await expect(page.locator('.donut-label')).toHaveText('a.test');

    await page.locator('.legend-row').last().click();
    await expect(page.locator('.all-sites .hbar')).toHaveCount(2);

    await expect(page.locator('.fact', { hasText: 'Longest unbroken stretch' })).toContainText('45m');
    await expect(page.locator('.fact', { hasText: 'most active around' })).toBeVisible();
    await expect(page.locator('.heat-cell')).toHaveCount(168);
  });

  test('animates page entrances, and stops for people who ask for less motion', async ({ h }) => {
    const page = await h.dashboard('today');
    await expect(page.locator('.hero')).toBeVisible();
    await page.locator('.nav-item', { hasText: 'Rules' }).click();
    const running = await page.evaluate(() => document.getAnimations().map((a) => (a as CSSAnimation).animationName));
    expect(running).toContain('unveil');
    const indicator = page.locator('.nav-indicator');
    await expect.poll(() => indicator.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42)).toBe(34 * 5);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.nav-item', { hasText: 'Today' }).click();
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await expect(page.locator('.stat-value').first()).not.toBeEmpty();
  });
});
