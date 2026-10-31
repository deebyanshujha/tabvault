import type { Id, LaterItem, LaterState } from '../shared/types';
import { laterParser } from '../shared/schemas';
import { del, mutate, putMany, readAll, readOne } from '../storage/db';
import { newId } from '../shared/ids';
import { isWorthSaving, urlKey } from '../shared/urls';
import { broadcast } from './runtime';
import { isOwnPage, tabUrl } from './capture';

const STORE = 'later';
export const SNOOZE_ALARM = 'snooze';

export const listLater = () => readAll<LaterItem>(STORE, laterParser);

/** Adding something already queued just refreshes it; a queue with repeats is a bad queue. */
export async function addToLater(links: { url: string; title: string }[], snoozeUntil?: number): Promise<LaterItem[]> {
  const usable = links.filter((l) => isWorthSaving(l.url) && !isOwnPage(l.url));
  const existing = await listLater();
  const byKey = new Map(existing.filter((i) => i.state !== 'done').map((i) => [urlKey(i.url), i]));
  const now = Date.now();
  const items = usable.map<LaterItem>((link) => {
    const prior = byKey.get(urlKey(link.url));
    return {
      id: prior?.id ?? newId(),
      url: link.url,
      title: link.title || link.url,
      state: snoozeUntil ? 'snoozed' : 'queued',
      ...(snoozeUntil ? { snoozeUntil } : {}),
      addedAt: prior?.addedAt ?? now,
    };
  });
  await putMany(STORE, items);
  await rescheduleSnoozes();
  broadcast('later');
  return items;
}

export async function addTabsToLater(tabIds: number[], { close = true, snoozeUntil }: { close?: boolean; snoozeUntil?: number }) {
  const tabs = (await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => null)))).filter((t): t is chrome.tabs.Tab => !!t);
  const items = await addToLater(tabs.map((t) => ({ url: tabUrl(t), title: t.title ?? '' })), snoozeUntil);
  const saved = new Set(items.map((i) => urlKey(i.url)));
  const closable = tabs.filter((t) => saved.has(urlKey(tabUrl(t)))).map((t) => t.id!);
  if (close && closable.length) await chrome.tabs.remove(closable).catch(() => undefined);
  return { added: items.length, skipped: tabs.length - items.length, itemIds: items.map((i) => i.id) };
}

export async function setLaterState(id: Id, state: LaterState): Promise<void> {
  await mutate<LaterItem>(STORE, id, (item) => {
    if (!item) return undefined;
    const { snoozeUntil: _s, doneAt: _d, ...rest } = item;
    return { ...rest, state, ...(state === 'done' ? { doneAt: Date.now() } : {}) };
  });
  await rescheduleSnoozes();
  broadcast('later');
}

export async function snoozeLater(id: Id, until: number): Promise<void> {
  await mutate<LaterItem>(STORE, id, (item) => item && { ...item, state: 'snoozed', snoozeUntil: until });
  await rescheduleSnoozes();
  broadcast('later');
}

export async function openLater(id: Id, { active = true, keep = false }: { active?: boolean; keep?: boolean }): Promise<void> {
  const item = await readOne<LaterItem>(STORE, id, laterParser);
  if (!item) throw new Error('That item is gone.');
  await chrome.tabs.create({ url: item.url, active });
  if (!keep) await setLaterState(id, 'done');
}

export async function removeLater(ids: Id[]): Promise<void> {
  await del(STORE, ids);
  await rescheduleSnoozes();
  broadcast('later');
}

/** Bring back whatever is due. Runs on the alarm and at startup. */
export async function wakeDueSnoozes(now = Date.now()): Promise<number> {
  const due = (await listLater()).filter((i) => i.state === 'snoozed' && (i.snoozeUntil ?? 0) <= now);
  if (due.length) {
    // No window to open into (e.g. all closed on macOS): leave them due for next time.
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (!windows.length) {
      await rescheduleSnoozes();
      return 0;
    }
    for (const item of due) {
      await chrome.tabs.create({ url: item.url, active: false }).catch(() => undefined);
      await mutate<LaterItem>(STORE, item.id, (i) => {
        if (!i) return undefined;
        const { snoozeUntil: _s, ...rest } = i;
        return { ...rest, state: 'done', doneAt: now };
      });
    }
    broadcast('later');
  }
  await rescheduleSnoozes();
  return due.length;
}

/** One alarm for the soonest item. It's cheap, and alarms survive worker death. */
export async function rescheduleSnoozes(): Promise<void> {
  const next = (await listLater())
    .filter((i) => i.state === 'snoozed' && i.snoozeUntil)
    .reduce<number | null>((min, i) => (min === null || i.snoozeUntil! < min ? i.snoozeUntil! : min), null);
  await chrome.alarms.clear(SNOOZE_ALARM);
  if (next !== null) await chrome.alarms.create(SNOOZE_ALARM, { when: Math.max(next, Date.now() + 1000) });
}
