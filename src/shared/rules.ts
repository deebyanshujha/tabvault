import { domainOf, matchesDomain } from './urls';
import type { Rule, RuleMatch } from './types';

// Deliberately no regex: patterns come from users and imports, and running them
// on every navigation would be a ReDoS risk for no real gain over these four kinds.
export function matchesRule(match: RuleMatch, tab: { url: string; title?: string }): boolean {
  const value = match.value.trim().toLowerCase();
  if (!value) return false;
  switch (match.kind) {
    case 'domain':
      return matchesDomain(domainOf(tab.url), value);
    case 'url-contains':
      return tab.url.toLowerCase().includes(value);
    case 'url-prefix':
      return tab.url.toLowerCase().startsWith(value);
    case 'title-contains':
      return (tab.title ?? '').toLowerCase().includes(value);
  }
}

export function rulesFor(rules: Rule[], tab: { url: string; title?: string }): Rule[] {
  return rules.filter((r) => r.enabled && matchesRule(r.match, tab)).sort((a, b) => a.order - b.order);
}

export function isProtectedByRules(rules: Rule[], tab: { url: string; title?: string }): boolean {
  return rulesFor(rules, tab).some((r) => r.action.type === 'protect');
}

export function describeRule(rule: Rule, workspaceName?: string): string {
  const m = rule.match;
  const when = {
    domain: `site is ${m.value}`,
    'url-contains': `URL contains “${m.value}”`,
    'url-prefix': `URL starts with ${m.value}`,
    'title-contains': `title contains “${m.value}”`,
  }[m.kind];
  const a = rule.action;
  const then =
    a.type === 'group' ? `group as “${a.title || 'untitled'}”` :
    a.type === 'pin' ? 'pin the tab' :
    a.type === 'protect' ? 'never sleep it or flag it as stale' :
    `file into ${workspaceName ?? 'a workspace'}`;
  return `When ${when}, ${then}`;
}
