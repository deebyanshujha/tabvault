import { chromium, test as base, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const DIST = resolve('dist');

/** Pages to open in tests, each with a recognizable title. Local only: no real network. */
export function startSite(): Promise<{ server: Server; url: (path: string) => string }> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').split('?')[0]!.slice(1)) || 'home';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Page ${name}</title><h1>${name}</h1><a id="link" target="_blank" href="/child-of-${name}">child</a>`);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      done({ server, url: (p) => `http://127.0.0.1:${port}/${p}` });
    });
  });
}

export async function launch(profile: string): Promise<{ context: BrowserContext; worker: Worker; extensionId: string }> {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  return { context, worker, extensionId };
}

export interface Harness {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  site: { url: (path: string) => string };
  profile: string;
  /** Extension page used to drive the RPC layer. */
  control: Page;
  open: (path: string) => Promise<Page>;
  dashboard: (route?: string) => Promise<Page>;
  popup: () => Promise<Page>;
  rpc: <T = unknown>(method: string, params?: object) => Promise<T>;
  allTabs: () => Promise<chrome.tabs.Tab[]>;
  errors: string[];
}

export async function makeHarness(context: BrowserContext, worker: Worker, extensionId: string, site: Harness['site'], profile: string): Promise<Harness> {
  const errors: string[] = [];
  const watch = (page: Page) => {
    if (!page.url().startsWith('chrome-extension://') && page.url() !== 'about:blank') return;
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
  };
  context.on('page', watch);

  const base = `chrome-extension://${extensionId}`;
  const control = await context.newPage();
  await control.goto(`${base}/sidepanel.html`);
  watch(control);

  // First install opens the dashboard asynchronously. Wait, so tests see a settled tab list.
  await expect.poll(() => control.evaluate((b) => chrome.tabs.query({}).then((tabs) => tabs.filter((t) => (t.pendingUrl || t.url || '').startsWith(`${b}/dashboard.html`)).length), base), { timeout: 5000 }).toBeGreaterThanOrEqual(0);
  await control.waitForTimeout(250);

  const rpc = async <T,>(method: string, params: object = {}) => {
    const r = await control.evaluate(([m, p]) => chrome.runtime.sendMessage({ kind: 'rpc', method: m, params: p }), [method, params] as const) as { ok: boolean; data: T; error: string };
    if (!r.ok) throw new Error(`${method}: ${r.error}`);
    return r.data;
  };

  return {
    context, worker, extensionId, site, profile, control, rpc, errors,
    open: async (path) => {
      const page = await context.newPage();
      await page.goto(site.url(path));
      return page;
    },
    dashboard: async (route = '') => {
      const page = await context.newPage();
      await page.goto(`${base}/dashboard.html${route ? `#/${route}` : ''}`);
      watch(page);
      await expect(page.locator('.shell')).toBeVisible();
      return page;
    },
    popup: async () => {
      const page = await context.newPage();
      await page.goto(`${base}/popup.html`);
      watch(page);
      await expect(page.locator('.palette')).toBeVisible();
      return page;
    },
    allTabs: () => control.evaluate(() => chrome.tabs.query({})),
  };
}

type Fixtures = { h: Harness };

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  h: async ({}, use) => {
    const profile = mkdtempSync(join(tmpdir(), 'tabvault-e2e-'));
    const site = await startSite();
    const { context, worker, extensionId } = await launch(profile);
    const h = await makeHarness(context, worker, extensionId, site, profile);
    await use(h);
    await context.close().catch(() => undefined);
    site.server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  },
});

export { expect };

export const OWN = (h: Harness) => `chrome-extension://${h.extensionId}/`;

/** Wait for the debounce pipeline to record what's open. */
export const settle = (page: Page, ms = 2200) => page.waitForTimeout(ms);
