import { describe, expect, it, vi } from 'vitest';
import { countQuarantined, get, mutate, put, rawAll, readAll, StorageError, transact } from '../../src/storage/db';
import { getPrefs, sanitizePrefs, setPrefs } from '../../src/storage/prefs';
import { workspaceParser } from '../../src/shared/schemas';
import { array, boolean, integer, nonEmpty, object, oneOf, optional, record, ValidationError } from '../../src/shared/validate';
import { DEFAULT_PREFS } from '../../src/shared/types';
import { laterParser, sessionParser } from '../../src/shared/schemas';

const ws = (id: string, over: object = {}) => ({
  id, name: id, color: 'blue', icon: 'layers', items: [], groups: [], autoSync: true, order: 0, createdAt: 1, updatedAt: 1, ...over,
});

describe('database', () => {
  it('round-trips a record', async () => {
    await put('workspaces', ws('a'));
    expect(await get('workspaces', 'a')).toMatchObject({ id: 'a' });
  });

  it('read-modify-write serializes concurrent updates', async () => {
    await put('kv', 0, 'n');
    await Promise.all(Array.from({ length: 25 }, () => mutate<number>('kv', 'n', (v) => (v ?? 0) + 1)));
    expect(await get('kv', 'n')).toBe(25);
  });

  it('mutate returning undefined writes nothing', async () => {
    await put('kv', 'x', 'k');
    await mutate<string>('kv', 'k', () => undefined);
    expect(await get('kv', 'k')).toBe('x');
  });

  it('rolls the whole transaction back on failure', async () => {
    await put('kv', 'before', 'k');
    await expect(
      transact('kv', 'readwrite', async (tx) => {
        await new Promise<void>((resolve, reject) => {
          const req = tx.objectStore('kv').put('after', 'k');
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
        throw new Error('boom');
      }),
    ).rejects.toBeInstanceOf(StorageError);
    expect(await get('kv', 'k')).toBe('before');
  });

  it('quarantines corrupt records and returns the rest', async () => {
    await put('workspaces', ws('good'));
    await put('workspaces', { id: 'bad', name: 12345 }); // name has the wrong type
    await put('workspaces', { id: 'also-bad' }); // name missing
    const rows = await readAll('workspaces', workspaceParser);
    expect(rows.map((r) => r.id)).toEqual(['good']);
    expect(await countQuarantined()).toBe(2);
    // They've been moved, not lost, and the store is clean now.
    expect(await rawAll('workspaces')).toHaveLength(1);
    expect(await rawAll<{ store: string }>('quarantine')).toEqual(expect.arrayContaining([expect.objectContaining({ store: 'workspaces' })]));
  });

  it('keeps a workspace whose one tab has a bad URL, dropping only that tab', async () => {
    await put('workspaces', ws('w', { items: [{ id: '1', url: 'javascript:alert(1)', title: 'x' }, { id: '2', url: 'https://ok.com', title: 'ok' }] }));
    const [row] = await readAll('workspaces', workspaceParser);
    expect(row!.items.map((t) => t.url)).toEqual(['https://ok.com']);
  });

  it('turns a full disk into a readable message', async () => {
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const err = await put('kv', 1, 'k').catch((e: unknown) => e);
    spy.mockRestore();
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).quota).toBe(true);
    expect((err as StorageError).message).toMatch(/disk is full/i);
  });
});

describe('prefs', () => {
  it('returns defaults when nothing is stored', async () => {
    expect(await getPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('merges a patch', async () => {
    await setPrefs({ staleDays: 3 });
    await setPrefs({ theme: 'dark' });
    expect(await getPrefs()).toMatchObject({ staleDays: 3, theme: 'dark', timeMachine: true });
  });

  it('repairs corrupt values and drops unknown keys', () => {
    const p = sanitizePrefs({ theme: 'neon', staleDays: 'soon', autoSleepMinutes: -5, evil: true, timeMachine: 'yes' });
    expect(p.theme).toBe('system');
    expect(p.staleDays).toBe(DEFAULT_PREFS.staleDays);
    expect(p.autoSleepMinutes).toBe(0);
    expect(p.timeMachine).toBe(true);
    expect('evil' in p).toBe(false);
    expect(sanitizePrefs(null)).toEqual(DEFAULT_PREFS);
  });
});

describe('validators', () => {
  it('rejects wrong types with a path', () => {
    const parser = object({ a: object({ b: integer }) });
    expect(() => parser({ a: { b: 'x' } })).toThrow(ValidationError);
    expect(() => parser({ a: { b: 'x' } })).toThrow(/a\.b/);
  });

  it('drops unknown keys and prototype pollution attempts', () => {
    const parsed = object({ a: boolean })(JSON.parse('{"a":true,"__proto__":{"polluted":1},"extra":1}'));
    expect(parsed).toEqual({ a: true });
    const rec = record(integer)(JSON.parse('{"__proto__":1,"ok":2}'));
    expect(Object.keys(rec)).toEqual(['ok']);
    expect(({} as { polluted?: number }).polluted).toBeUndefined();
  });

  it('enforces limits', () => {
    expect(() => array(integer, 2)([1, 2, 3])).toThrow();
    expect(nonEmpty(3)('abcdef')).toBe('abc');
    expect(() => nonEmpty()('   ')).toThrow();
    expect(() => oneOf(['a'] as const)('b')).toThrow();
    expect(optional(integer)(undefined)).toBeUndefined();
  });

  it('refuses unsafe URLs in stored later items and sessions', () => {
    expect(() => laterParser({ id: 'x', url: 'javascript:alert(1)' })).toThrow();
    const session = sessionParser({ id: 's', name: 'n', windows: [{ tabs: [{ url: 'data:text/html,x' }, { url: 'https://a.com' }] }] });
    expect(session.windows[0]!.tabs.map((t) => t.url)).toEqual(['https://a.com']);
  });
});
