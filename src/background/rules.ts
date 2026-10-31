import type { Rule, RuleAction, RuleMatch, TabColor } from '../shared/types';
import { del, put, readAll } from '../storage/db';
import { ruleParser } from '../shared/schemas';
import { newId } from '../shared/ids';
import { rulesFor } from '../shared/rules';
import { domainOf, isWebUrl } from '../shared/urls';
import { broadcast, getTabMeta, updateTabMeta, windowForWorkspace } from './runtime';
import { addToGroup, groupIntoNew, tabUrl, toChromeColor } from './capture';
import { addLinkToWorkspace } from './workspaces';

export const listRules = async () => (await readAll<Rule>('rules', ruleParser)).sort((a, b) => a.order - b.order);

export async function saveRule(input: { id?: string; name?: string; enabled?: boolean; match: RuleMatch; action: RuleAction }): Promise<Rule> {
  const all = await listRules();
  const prior = input.id ? all.find((r) => r.id === input.id) : undefined;
  const rule: Rule = {
    id: prior?.id ?? newId(),
    name: input.name ?? prior?.name ?? '',
    enabled: input.enabled ?? prior?.enabled ?? true,
    match: input.match,
    action: input.action,
    order: prior?.order ?? all.reduce((n, r) => Math.max(n, r.order + 1), 0),
    createdAt: prior?.createdAt ?? Date.now(),
  };
  await put('rules', rule);
  broadcast('rules');
  return rule;
}

export async function deleteRule(id: string): Promise<void> {
  await del('rules', id);
  broadcast('rules');
}

async function ensureGroup(tab: chrome.tabs.Tab, title: string, color: TabColor): Promise<void> {
  if (tab.pinned || tab.id === undefined) return;
  const [group] = await chrome.tabGroups.query({ windowId: tab.windowId, title });
  if (group) {
    if (tab.groupId !== group.id) await addToGroup([tab.id], group.id);
    return;
  }
  const groupId = await groupIntoNew([tab.id], tab.windowId);
  await chrome.tabGroups.update(groupId, { title, color: toChromeColor(color) });
}

async function applyAction(rule: Rule, tab: chrome.tabs.Tab): Promise<void> {
  const action = rule.action;
  switch (action.type) {
    case 'group':
      await ensureGroup(tab, action.title, action.color);
      break;
    case 'pin':
      if (!tab.pinned) await chrome.tabs.update(tab.id!, { pinned: true });
      break;
    case 'workspace': {
      const windowId = await windowForWorkspace(action.workspaceId);
      if (windowId !== null) {
        if (tab.windowId !== windowId) await chrome.tabs.move(tab.id!, { windowId, index: -1 });
      } else {
        await addLinkToWorkspace(action.workspaceId, tabUrl(tab), tab.title ?? '');
      }
      break;
    }
    case 'protect':
      break; // read by sleep and stale logic
  }
}

/**
 * Apply matching rules once per tab + rule + site. If the user drags a tab back out
 * of a group afterwards, the rule won't fight them on every reload.
 */
export async function applyRulesToTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  const url = tabUrl(tab);
  if (!isWebUrl(url)) return;
  const rules = rulesFor(await listRules(), { url, title: tab.title });
  if (!rules.length) return;
  const domain = domainOf(url);
  const meta = (await getTabMeta())[String(tab.id)];
  const applied = new Set(meta?.applied ?? []);
  for (const rule of rules) {
    const mark = `${rule.id}|${domain}`;
    if (applied.has(mark)) continue;
    applied.add(mark);
    try {
      await applyAction(rule, tab);
    } catch {
      // Chrome rejects tab edits while a tab is being dragged. Try once more shortly.
      setTimeout(() => {
        chrome.tabs.get(tab.id!).then((fresh) => applyAction(rule, fresh)).catch(() => undefined);
      }, 400);
    }
  }
  await updateTabMeta(tab.id, (m) => ({ createdAt: m?.createdAt ?? Date.now(), ...m, applied: [...applied] }));
}

/** "Apply now" from the Rules view: every open tab, ignoring the once-only memo. */
export async function applyRulesToAll(): Promise<number> {
  const rules = await listRules();
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  let hits = 0;
  for (const tab of tabs) {
    const url = tabUrl(tab);
    if (!isWebUrl(url)) continue;
    for (const rule of rulesFor(rules, { url, title: tab.title })) {
      if (rule.action.type === 'protect') continue;
      try {
        const fresh = await chrome.tabs.get(tab.id!);
        await applyAction(rule, fresh);
        hits++;
      } catch {
        // the tab went away or can't be edited; carry on with the rest
      }
    }
  }
  return hits;
}
