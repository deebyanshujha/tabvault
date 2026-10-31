import { DEFAULT_PREFS, type Prefs } from '../shared/types';

const KEY = 'prefs';

// Prefs live in chrome.storage.local rather than IndexedDB: pages read them before
// first paint to avoid a theme flash, and storage.onChanged gives us cross-context updates.
export async function getPrefs(): Promise<Prefs> {
  const stored = await chrome.storage.local.get(KEY);
  return sanitizePrefs(stored[KEY]);
}

/** Unknown keys are dropped and wrong-typed values fall back to the default. */
export function sanitizePrefs(input: unknown): Prefs {
  const out: Prefs = { ...DEFAULT_PREFS };
  if (typeof input !== 'object' || input === null) return out;
  const target = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_PREFS)) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === typeof DEFAULT_PREFS[key as keyof Prefs]) target[key] = value;
  }
  if (!['system', 'dark', 'light'].includes(out.theme)) out.theme = DEFAULT_PREFS.theme;
  if (!['alerts', 'tabs', 'off'].includes(out.badge)) out.badge = DEFAULT_PREFS.badge;
  if (!['new-window', 'replace'].includes(out.workspaceOpenMode)) out.workspaceOpenMode = DEFAULT_PREFS.workspaceOpenMode;
  out.autoSleepMinutes = Math.max(0, Math.min(10_080, out.autoSleepMinutes));
  out.staleDays = Math.max(1, Math.min(365, out.staleDays));
  return out;
}

export async function setPrefs(patch: Partial<Prefs>): Promise<Prefs> {
  const next = sanitizePrefs({ ...(await getPrefs()), ...patch });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export const PREFS_KEY = KEY;
