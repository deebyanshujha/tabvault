// Drives the built extension with demo data and captures every screen.
// Every hostname is forced to a local server with --host-resolver-rules, because
// Playwright's route() does not see tabs opened through chrome.tabs.create. Demo
// sites use the reserved .test TLD so nothing could reach a real site regardless. Usage:
//   node scripts/screenshots.mjs [outDir] [light|dark]
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OUT = resolve(process.argv[2] ?? 'screenshots');
const THEME = process.argv[3] ?? 'dark';
mkdirSync(OUT, { recursive: true });

const SITES = {
  'github.com': ['#24292f', 'G'], 'developer.mozilla.org': ['#111', 'M'], 'stackoverflow.com': ['#f48024', 'S'], 'news.ycombinator.com': ['#ff6600', 'Y'],
  'arxiv.org': ['#b31b1b', 'a'], 'en.wikipedia.org': ['#555', 'W'], 'www.youtube.com': ['#f00', '▶'], 'docs.python.org': ['#3776ab', 'P'], 'leetcode.com': ['#ffa116', 'L'],
  'www.nytimes.com': ['#000', 'T'], 'mail.google.com': ['#ea4335', 'M'], 'calendar.google.com': ['#4285f4', 'C'], 'www.figma.com': ['#a259ff', 'F'], 'react.dev': ['#149eca', 'R'],
};
const demoHost = (host) => host.replace(/\.[a-z]+$/, '').replace(/^www\./, '').replace(/\./g, '-') + '.test';
const P = (host, path, title) => ({ url: `http://${demoHost(host)}${path}`, title });
const MAIN = [
  P('github.com', '/acme/api/pull/482', 'Fix race in session restore · Pull Request #482'),
  P('github.com', '/acme/api/issues/511', 'Tab groups lost after crash · Issue #511'),
  P('github.com', '/acme/web/pulls', 'Pull requests · acme/web'),
  P('github.com', '/acme/api/actions', 'Actions · acme/api'),
  P('github.com', '/acme/docs', 'acme/docs: Product documentation'),
  P('developer.mozilla.org', '/en-US/docs/Web/API/IndexedDB_API', 'IndexedDB API - Web APIs | MDN'),
  P('developer.mozilla.org', '/en-US/docs/Web/API/IDBTransaction', 'IDBTransaction - Web APIs | MDN'),
  P('stackoverflow.com', '/questions/44/service-worker-lifetime', 'How long does a service worker stay alive? - Stack Overflow'),
  P('stackoverflow.com', '/questions/44/service-worker-lifetime', 'How long does a service worker stay alive? - Stack Overflow'),
  P('react.dev', '/reference/react/useMemo', 'useMemo – React'),
  P('news.ycombinator.com', '/item?id=41', 'Show HN: A local-first tab manager | Hacker News'),
  P('www.nytimes.com', '/2026/10/30/technology/browsers.html', 'The Quiet Return of the Browser Wars'),
  P('mail.google.com', '/mail/u/0/#inbox', 'Inbox (12) - Gmail'),
  P('calendar.google.com', '/calendar/u/0/r', 'Calendar - Week of October 26'),
];
const SECOND = [
  P('arxiv.org', '/abs/2410.01234', 'Attention Residuals in Long-Context Models'),
  P('arxiv.org', '/abs/2409.09876', 'A Survey of Memory-Efficient Retrieval'),
  P('en.wikipedia.org', '/wiki/Local-first_software', 'Local-first software - Wikipedia'),
  P('www.youtube.com', '/watch?v=abc', 'CRDTs: The Hard Parts - YouTube'),
];
const WS = {
  Interview: [P('leetcode.com', '/problemset/', 'Problems - LeetCode'), P('leetcode.com', '/problems/lru-cache/', 'LRU Cache - LeetCode'), P('github.com', '/kdn251/interviews', 'kdn251/interviews'), P('en.wikipedia.org', '/wiki/Big_O_notation', 'Big O notation - Wikipedia')],
  Thesis: SECOND,
  Python: [P('docs.python.org', '/3/library/asyncio.html', 'asyncio — Asynchronous I/O'), P('docs.python.org', '/3/library/typing.html', 'typing — Support for type hints')],
};

const titleFor = (url) => [...MAIN, ...SECOND, ...Object.values(WS).flat()].find((p) => p.url === url)?.title ?? new URL(url).pathname;
// Favicons are only cached for real navigations, so give them time to land.
const page404 = (url) => {
  const host = new URL(url).host;
  const [color, letter] = Object.entries(SITES).find(([h]) => demoHost(h) === host)?.[1] ?? ['#777', '?'];
  const icon = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${color}"/><text x="16" y="23" font-family="Arial" font-weight="700" font-size="20" fill="#fff" text-anchor="middle">${letter}</text></svg>`)}`;
  return `<!doctype html><title>${titleFor(url).replace(/</g, '&lt;')}</title><link rel="icon" href="${icon}"><h1>${host}</h1>`;
};

const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(page404(`http://${req.headers.host}${req.url}`));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;

const profile = mkdtempSync(join(tmpdir(), 'tabvault-shots-'));
const dist = resolve('dist');
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2,
  colorScheme: THEME === 'light' ? 'light' : 'dark',
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--no-first-run', `--host-resolver-rules=MAP * 127.0.0.1:${port}`],
});

let [worker] = context.serviceWorkers();
worker ??= await context.waitForEvent('serviceworker');
const id = new URL(worker.url()).host;
const base = `chrome-extension://${id}`;

const control = await context.newPage();
await control.goto(`${base}/sidepanel.html`);
await control.evaluate((theme) => chrome.storage.local.set({ prefs: { theme, onboarded: true } }), THEME);
const rpc = async (method, params = {}) => {
  const r = await control.evaluate(([m, p]) => chrome.runtime.sendMessage({ kind: 'rpc', method: m, params: p }), [method, params]);
  if (!r.ok) throw new Error(`${method}: ${r.error}`);
  return r.data;
};
const sleep = (ms) => control.waitForTimeout(ms);

for (const p of MAIN) await control.evaluate((u) => chrome.tabs.create({ url: u, active: false }), p.url);
const secondWin = await control.evaluate((urls) => chrome.windows.create({ url: urls, focused: false }).then((w) => w.id), SECOND.map((s) => s.url));
await sleep(1500);

const created = {};
const colors = { Interview: ['orange', 'briefcase'], Thesis: ['purple', 'flask'], Python: ['green', 'code'] };
for (const [name, links] of Object.entries(WS)) {
  if (name === 'Thesis') {
    created[name] = await rpc('workspace.create', { name, color: colors[name][0], icon: colors[name][1], fromWindowId: secondWin, bind: true });
  } else {
    created[name] = await rpc('workspace.create', { name, color: colors[name][0], icon: colors[name][1], links });
  }
}
await rpc('session.save', { scope: 'all', name: 'Before the API refactor' });
await rpc('session.snapshotNow');
await rpc('later.addLink', { url: 'http://nytimes.test/2026/10/30/technology/browsers.html', title: 'The Quiet Return of the Browser Wars' });
await rpc('later.addLink', { url: 'http://en-wikipedia.test/wiki/Bloom_filter', title: 'Bloom filter - Wikipedia' });
await rpc('later.addLink', { url: 'http://figma.test/file/abc/design', title: 'TabVault marketing site', snoozeUntil: Date.now() + 864e5 });
await rpc('note.set', { url: 'http://github.test/acme/api/pull/482', text: 'Review before Friday standup' });
await rpc('rule.save', { match: { kind: 'domain', value: 'github.com' }, action: { type: 'group', title: 'GitHub', color: 'purple' }, enabled: false });
await rpc('rule.save', { match: { kind: 'domain', value: 'mail.google.com' }, action: { type: 'pin' }, enabled: false });
await rpc('rule.save', { match: { kind: 'domain', value: 'music.youtube.com' }, action: { type: 'protect' } });
await sleep(1800);

await control.evaluate(async () => {
  const sites = [['github.com', 9000], ['youtube.com', 5400], ['docs.python.org', 3200], ['stackoverflow.com', 2300], ['news.ycombinator.com', 1500], ['en.wikipedia.org', 900], ['leetcode.com', 700], ['arxiv.org', 500], ['figma.com', 300]];
  const db = await new Promise((done, fail) => { const r = indexedDB.open('tabvault'); r.onsuccess = () => done(r.result); r.onerror = () => fail(r.error); });
  const tx = db.transaction('activity', 'readwrite');
  const store = tx.objectStore('activity');
  const pad = (n) => String(n).padStart(2, '0');
  for (let i = 1; i < 21; i++) {
    const d = new Date(Date.now() - i * 864e5);
    const weekend = d.getDay() % 6 === 0;
    const wave = 0.55 + 0.45 * Math.sin(i * 1.7);
    const focusSeconds = Object.fromEntries(sites.slice(i > 12 ? 2 : 0).map(([s, base], n) => [s, Math.round(base * wave * (weekend ? 0.4 : 1) * (1 - (n * i) % 3 / 7))]));
    const total = Object.values(focusSeconds).reduce((a, b) => a + b, 0);
    const shape = weekend ? [10, 11, 12, 20, 21, 22, 23] : [9, 10, 11, 14, 15, 16, 21, 22];
    const hours = Object.fromEntries(shape.map((h, n) => [String(h), Math.round(total * (n % 3 === 1 ? 0.22 : 0.09))]));
    store.put({ day: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), focusSeconds, hours, switches: Math.round(total / 140), longest: { domain: 'github.com', seconds: Math.round(2200 + 1600 * wave) }, opened: Math.round(30 * wave) + 6, closed: Math.round(24 * wave) + 4, peakTabs: Math.round(26 + 14 * wave) });
  }
  await new Promise((done) => { tx.oncomplete = done; });
  db.close();
});

const shot = async (name, route, prep) => {
  const page = await context.newPage();
  await page.goto(`${base}/${route}`);
  await page.waitForTimeout(700);
  if (prep) await prep(page);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.close();
};

await shot('today', 'dashboard.html#/today', (p) => p.waitForTimeout(900));
await shot('tabs', 'dashboard.html#/tabs');
await shot('tabs-selected', 'dashboard.html#/tabs', async (p) => {
  const checks = p.locator('.tab-row .tab-check');
  await checks.nth(1).check();
  await checks.nth(2).check();
  await checks.nth(3).check();
});
await shot('workspaces', 'dashboard.html#/workspaces');
await shot('workspace-new', 'dashboard.html#/workspaces/new');
await shot('workspace-detail', `dashboard.html#/workspaces/${created.Interview.id}`);
await shot('vault', 'dashboard.html#/vault', async (p) => { await p.locator('.vault-item').first().click(); await p.waitForTimeout(300); });
await shot('workspaces-hover', 'dashboard.html#/workspaces', async (p) => { await p.locator('.ws-card').first().hover(); await p.waitForTimeout(700); });
await shot('later', 'dashboard.html#/later');
await shot('rules', 'dashboard.html#/rules');
await shot('insights', 'dashboard.html#/insights', (p) => p.waitForTimeout(1200));
await shot('insights-share', 'dashboard.html#/insights', async (p) => { await p.locator('.legend').scrollIntoViewIfNeeded(); await p.locator('.page').evaluate((el) => { el.scrollTop = 560; }); await p.waitForTimeout(1300); });
await shot('insights-grid', 'dashboard.html#/insights', async (p) => { await p.locator('.page').evaluate((el) => { el.scrollTop = 1120; }); await p.waitForTimeout(1300); });
await shot('today-bottom', 'dashboard.html#/today', async (p) => { await p.locator('.page').evaluate((el) => { el.scrollTop = el.scrollHeight; }); await p.waitForTimeout(800); });
await shot('settings', 'dashboard.html#/settings');
await shot('settings-bottom', 'dashboard.html#/settings', (p) => p.locator('.page').evaluate((el) => { el.scrollTop = el.scrollHeight; }));
await shot('time-machine', 'dashboard.html#/vault', async (p) => { await p.getByRole('radio', { name: 'Time Machine' }).click(); await p.locator('.vault-item').first().click(); await p.waitForTimeout(300); });
await shot('palette-modal', 'dashboard.html#/today', async (p) => { await p.keyboard.press('Control+k'); await p.waitForTimeout(200); await p.keyboard.type('review'); });

const popup = async (name, prep) => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 680, height: 540 });
  await page.goto(`${base}/popup.html`);
  await page.waitForTimeout(600);
  if (prep) await prep(page);
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  await page.close();
};
await popup('popup-home');
await popup('popup-search', (p) => p.keyboard.type('github'));
await popup('popup-commands', (p) => p.keyboard.type('>'));
await popup('popup-actions', async (p) => { await p.keyboard.press('Control+k'); });

const narrow = await context.newPage();
await narrow.setViewportSize({ width: 780, height: 600 });
await narrow.goto(`${base}/dashboard.html#/tabs`);
await narrow.waitForTimeout(600);
await narrow.locator('.tab-row .tab-check').nth(1).check();
await narrow.waitForTimeout(200);
await narrow.screenshot({ path: join(OUT, 'narrow-tabs.png') });
await narrow.close();

await control.evaluate((theme) => chrome.storage.local.set({ prefs: { theme, onboarded: false } }), THEME);
await shot('onboarding', 'dashboard.html#/today');

const panel = await context.newPage();
await panel.setViewportSize({ width: 360, height: 800 });
await panel.goto(`${base}/sidepanel.html`);
await panel.waitForTimeout(600);
await panel.screenshot({ path: join(OUT, 'sidepanel.png') });

await context.close();
server.close();
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log('screenshots in', OUT);
