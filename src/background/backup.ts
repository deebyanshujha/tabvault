// Export/import. Imports are untrusted input: every record is re-validated, URLs go
// through the same allowlist as everything else, and the merge happens in a single
// transaction, so a bad file can't leave the vault half-updated.

import type { Annotation, LaterItem, Prefs, Rule, Session, Workspace } from '../shared/types';
import { annotationParser, laterParser, ruleParser, sessionParser, workspaceParser } from '../shared/schemas';
import { parseLinkList } from '../shared/importers';
import { newId } from '../shared/ids';
import { tryParse } from '../shared/validate';
import { DB_VERSION, readAll, request, transact, type StoreName } from '../storage/db';
import { getPrefs, sanitizePrefs, setPrefs } from '../storage/prefs';
import { broadcast } from './runtime';
import { saveWindowsAsSession } from './sessions';

export const BACKUP_FORMAT = 'tabvault-backup';

export interface Backup {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  exportedAt: number;
  data: {
    workspaces: Workspace[];
    sessions: Session[];
    later: LaterItem[];
    annotations: Annotation[];
    rules: Rule[];
    prefs: Prefs;
  };
}

export async function exportBackup(): Promise<Backup> {
  const [workspaces, sessions, later, annotations, rules, prefs] = await Promise.all([
    readAll<Workspace>('workspaces', workspaceParser),
    readAll<Session>('sessions', sessionParser),
    readAll<LaterItem>('later', laterParser),
    readAll<Annotation>('annotations', annotationParser),
    readAll<Rule>('rules', ruleParser),
    getPrefs(),
  ]);
  return {
    format: BACKUP_FORMAT,
    schemaVersion: DB_VERSION,
    exportedAt: Date.now(),
    data: {
      workspaces: workspaces.filter((w) => !w.deletedAt),
      // Automatic snapshots are bulky and reproducible in spirit; manual saves are what matter.
      sessions: sessions.filter((s) => s.kind !== 'auto' && !s.deletedAt),
      later,
      annotations,
      rules,
      prefs,
    },
  };
}

export interface ImportSummary {
  workspaces: number;
  sessions: number;
  later: number;
  annotations: number;
  rules: number;
  rejected: number;
}

function parseAll<T>(rows: unknown, parser: (v: unknown) => T): { good: T[]; bad: number } {
  if (!Array.isArray(rows)) return { good: [], bad: 0 };
  const good: T[] = [];
  let bad = 0;
  for (const row of rows) {
    const parsed = tryParse(parser, row);
    if (parsed) good.push(parsed);
    else bad++;
  }
  return { good, bad };
}

/** Merge, never replace: on an id clash the newer record wins and nothing else is touched. */
export async function importBackup(json: string): Promise<ImportSummary> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('That file isn’t valid JSON.');
  }
  const backup = raw as Partial<Backup> | null;
  if (backup?.format !== BACKUP_FORMAT || typeof backup.data !== 'object' || !backup.data) {
    throw new Error('That isn’t a TabVault backup file.');
  }
  if (typeof backup.schemaVersion !== 'number' || backup.schemaVersion > DB_VERSION) {
    throw new Error('This backup was made by a newer version of TabVault. Update the extension first.');
  }
  const d = backup.data;
  const workspaces = parseAll(d.workspaces, workspaceParser);
  const sessions = parseAll(d.sessions, sessionParser);
  const later = parseAll(d.later, laterParser);
  const annotations = parseAll(d.annotations, annotationParser);
  const rules = parseAll(d.rules, ruleParser);

  const merge = async <T>(tx: IDBTransaction, store: StoreName, rows: T[], key: (r: T) => string, stamp: (r: T) => number) => {
    const os = tx.objectStore(store);
    for (const row of rows) {
      const existing = await request<T | undefined>(os.get(key(row)));
      if (!existing || stamp(row) >= stamp(existing)) await request(os.put(row));
    }
  };

  await transact(['workspaces', 'sessions', 'later', 'annotations', 'rules'], 'readwrite', async (tx) => {
    await merge(tx, 'workspaces', workspaces.good, (r) => r.id, (r) => r.updatedAt);
    await merge(tx, 'sessions', sessions.good, (r) => r.id, (r) => r.updatedAt);
    await merge(tx, 'later', later.good, (r) => r.id, (r) => r.addedAt);
    await merge(tx, 'annotations', annotations.good, (r) => r.urlKey, (r) => r.updatedAt);
    await merge(tx, 'rules', rules.good, (r) => r.id, (r) => r.createdAt);
  });
  if (d.prefs) await setPrefs({ ...sanitizePrefs(d.prefs), onboarded: true });
  broadcast('workspaces', 'sessions', 'later', 'annotations', 'rules');
  return {
    workspaces: workspaces.good.length,
    sessions: sessions.good.length,
    later: later.good.length,
    annotations: annotations.good.length,
    rules: rules.good.length,
    rejected: workspaces.bad + sessions.bad + later.bad + annotations.bad + rules.bad,
  };
}

/** OneTab-style and plain URL lists become one session, one window per group. */
export async function importLinks(text: string, name?: string): Promise<{ sessionId: string; tabs: number; ignored: number }> {
  const { groups, ignored } = parseLinkList(text);
  if (!groups.length) throw new Error('No usable links found. Paste one URL per line.');
  const now = Date.now();
  const session = await saveWindowsAsSession(
    groups.map((g) => ({
      id: newId(),
      focused: false,
      groups: [],
      tabs: g.map((l) => ({ id: newId(), url: l.url, title: l.title, pinned: false, addedAt: now })),
    })),
    { kind: 'imported', name: name?.trim() || `Imported · ${new Date(now).toLocaleDateString()}` },
  );
  return { sessionId: session.id, tabs: session.tabCount, ignored };
}

export async function wipeEverything(): Promise<void> {
  const stores: StoreName[] = ['workspaces', 'sessions', 'later', 'annotations', 'rules', 'activity', 'kv', 'quarantine'];
  await transact(stores, 'readwrite', async (tx) => {
    await Promise.all(stores.map((s) => request(tx.objectStore(s).clear())));
  });
  await chrome.storage.session.remove(['bindings']);
  broadcast('workspaces', 'sessions', 'later', 'annotations', 'rules', 'bindings', 'recovery', 'activity');
}
