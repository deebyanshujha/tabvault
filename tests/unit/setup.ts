import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach } from 'vitest';
import { resetConnection } from '../../src/storage/db';
import { installFakeChrome, type FakeBrowser } from './fake-chrome';

export let browser: FakeBrowser;

// Each test gets an empty database and an empty browser.
beforeEach(() => {
  resetConnection();
  globalThis.indexedDB = new IDBFactory();
  browser = installFakeChrome();
  (globalThis as unknown as { __browser: FakeBrowser }).__browser = browser;
});
