// Query language and ranking for the palette. Pure and synchronous: documents are
// prepared once (lower-cased) so each keystroke is just a linear scan.

import { DAY, HOUR, MINUTE } from './time';

export type DocKind = 'tab' | 'workspace' | 'workspace-item' | 'session' | 'session-tab' | 'later' | 'timeline' | 'closed' | 'command';

export const IN_ALIASES: Record<string, DocKind[]> = {
  tab: ['tab'], tabs: ['tab'], open: ['tab'],
  workspace: ['workspace', 'workspace-item'], workspaces: ['workspace', 'workspace-item'], ws: ['workspace', 'workspace-item'],
  session: ['session', 'session-tab'], sessions: ['session', 'session-tab'], vault: ['session', 'session-tab'],
  later: ['later'], queue: ['later'],
  timeline: ['timeline'], history: ['timeline'], past: ['timeline'],
  closed: ['closed'], recent: ['closed'],
  command: ['command'], commands: ['command'],
};

const OPERATORS = new Set(['in', 'domain', 'site', 'title', 'url', 'note', 'group', 'workspace', 'session', 'is', 'older', 'newer']);

export interface SearchDoc {
  id: string;
  kind: DocKind;
  title: string;
  url: string;
  domain: string;
  note?: string;
  /** Unix ms: when the thing was last used, for recency boost and older:/newer: */
  at?: number;
  /** is: flags such as pinned, audible, duplicate, stale, asleep, grouped */
  flags?: string[];
  /** Name of the containing group/workspace/session/window */
  container?: string;
  keywords?: string;
}

export interface Prepared extends SearchDoc {
  _title: string;
  _url: string;
  _note: string;
  _container: string;
  _keywords: string;
}

export function prepare(doc: SearchDoc): Prepared {
  return {
    ...doc,
    _title: doc.title.toLowerCase(),
    _url: doc.url.toLowerCase(),
    _note: (doc.note ?? '').toLowerCase(),
    _container: (doc.container ?? '').toLowerCase(),
    _keywords: (doc.keywords ?? '').toLowerCase(),
  };
}

export interface Term {
  text: string;
  negate: boolean;
  phrase: boolean;
}

export interface ParsedQuery {
  terms: Term[];
  kinds: DocKind[] | null;
  domains: string[];
  notDomains: string[];
  titles: string[];
  urls: string[];
  notes: string[];
  containers: string[];
  flags: string[];
  notFlags: string[];
  olderThan?: number;
  newerThan?: number;
  commandMode: boolean;
  isEmpty: boolean;
}

const TOKEN = /(-?)(?:([a-z]+):)?(?:"([^"]*)"?|(\S+))/gi;

export function parseDuration(text: string): number | null {
  const m = /^(\d+)(m|h|d|w)$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  return n * (unit === 'm' ? MINUTE : unit === 'h' ? HOUR : unit === 'd' ? DAY : 7 * DAY);
}

export function parseQuery(input: string): ParsedQuery {
  const q: ParsedQuery = {
    terms: [], kinds: null, domains: [], notDomains: [], titles: [], urls: [], notes: [], containers: [],
    flags: [], notFlags: [], commandMode: false, isEmpty: true,
  };
  let text = input.trim();
  if (text.startsWith('>')) {
    q.commandMode = true;
    q.kinds = ['command'];
    text = text.slice(1).trim();
  }
  for (const match of text.matchAll(TOKEN)) {
    const negate = match[1] === '-';
    const op = match[2]?.toLowerCase();
    const phrase = match[3] !== undefined;
    const value = (match[3] ?? match[4] ?? '').toLowerCase();
    if (!value) continue;
    // A half-typed operator ("is:") shouldn't blank the results while typing.
    if (!op && value.endsWith(':') && OPERATORS.has(value.slice(0, -1))) continue;
    switch (op) {
      case 'in': {
        const kinds = IN_ALIASES[value];
        if (kinds) q.kinds = [...(q.kinds ?? []), ...kinds];
        break;
      }
      case 'domain':
      case 'site':
        (negate ? q.notDomains : q.domains).push(value.replace(/^www\./, ''));
        break;
      case 'title': q.titles.push(value); break;
      case 'url': q.urls.push(value); break;
      case 'note': q.notes.push(value); break;
      case 'group':
      case 'workspace':
      case 'session':
        q.containers.push(value);
        break;
      case 'is':
        (negate ? q.notFlags : q.flags).push(value);
        break;
      case 'older': {
        const d = parseDuration(value);
        if (d !== null) q.olderThan = d;
        break;
      }
      case 'newer': {
        const d = parseDuration(value);
        if (d !== null) q.newerThan = d;
        break;
      }
      default:
        // An unknown prefix like "http:" or "foo:bar" is just text.
        q.terms.push({ text: op ? `${op}:${value}` : value, negate, phrase });
    }
  }
  q.isEmpty =
    !q.terms.length && !q.kinds && !q.domains.length && !q.notDomains.length && !q.titles.length && !q.urls.length &&
    !q.notes.length && !q.containers.length && !q.flags.length && !q.notFlags.length &&
    q.olderThan === undefined && q.newerThan === undefined && !q.commandMode;
  return q;
}

/** Subsequence match; tighter clusters and word starts score higher. -1 when no match. */
export function fuzzyScore(needle: string, hay: string): number {
  if (!needle) return 0;
  const direct = hay.indexOf(needle);
  if (direct >= 0) {
    const atWord = direct === 0 || !/[a-z0-9]/.test(hay[direct - 1]!);
    return 100 + (atWord ? 40 : 0) + (direct === 0 ? 20 : 0) - Math.min(direct, 20) * 0.5 + (needle.length / Math.max(hay.length, 1)) * 30;
  }
  if (needle.length < 2) return -1;
  let score = 0;
  let from = 0;
  let last = -2;
  for (let i = 0; i < needle.length; i++) {
    const at = hay.indexOf(needle[i]!, from);
    if (at < 0) return -1;
    const wordStart = at === 0 || !/[a-z0-9]/.test(hay[at - 1]!);
    score += at === last + 1 ? 6 : wordStart ? 5 : 1;
    if (at - last > 12 && i > 0) score -= 2;
    last = at;
    from = at + 1;
  }
  return score >= needle.length * 3 ? score : -1;
}

const KIND_BOOST: Record<DocKind, number> = {
  tab: 30, workspace: 26, command: 20, later: 16, session: 14, 'workspace-item': 12, 'session-tab': 8, closed: 6, timeline: 2,
};

function termScore(term: string, phrase: boolean, doc: Prepared): number {
  if (phrase) {
    if (doc._title.includes(term)) return 120;
    if (doc._note.includes(term)) return 90;
    if (doc._url.includes(term)) return 80;
    if (doc._keywords.includes(term)) return 70;
    return -1;
  }
  let best = -1;
  const title = fuzzyScore(term, doc._title);
  if (title >= 0) best = title * 1.2;
  if (doc.domain.includes(term)) best = Math.max(best, 100 + (doc.domain.startsWith(term) ? 30 : 0));
  if (doc._note.includes(term)) best = Math.max(best, 95);
  if (doc._keywords.includes(term)) best = Math.max(best, 85);
  if (doc._url.includes(term)) best = Math.max(best, 70);
  if (doc._container.includes(term)) best = Math.max(best, 40);
  return best;
}

export interface Hit {
  doc: Prepared;
  score: number;
}

export function search(docs: Prepared[], query: ParsedQuery, now = Date.now(), limit = 200): Hit[] {
  const kinds = query.kinds ? new Set(query.kinds) : null;
  const hits: Hit[] = [];
  outer: for (const doc of docs) {
    // Commands only show up when asked for or when actually typed at.
    if (kinds ? !kinds.has(doc.kind) : doc.kind === 'command' && !query.terms.length) continue;
    for (const d of query.domains) if (!doc.domain.includes(d)) continue outer;
    for (const d of query.notDomains) if (doc.domain.includes(d)) continue outer;
    for (const t of query.titles) if (!doc._title.includes(t)) continue outer;
    for (const t of query.urls) if (!doc._url.includes(t)) continue outer;
    for (const t of query.notes) if (!doc._note.includes(t)) continue outer;
    for (const t of query.containers) if (!doc._container.includes(t)) continue outer;
    for (const f of query.flags) if (!doc.flags?.includes(f)) continue outer;
    for (const f of query.notFlags) if (doc.flags?.includes(f)) continue outer;
    if (query.olderThan !== undefined && (doc.at === undefined || now - doc.at < query.olderThan)) continue;
    if (query.newerThan !== undefined && (doc.at === undefined || now - doc.at > query.newerThan)) continue;

    let score = KIND_BOOST[doc.kind];
    for (const term of query.terms) {
      const s = termScore(term.text, term.phrase, doc);
      if (term.negate) {
        if (s >= 0) continue outer;
      } else {
        if (s < 0) continue outer;
        score += s;
      }
    }
    if (doc.at) score += 15 * Math.exp(-(now - doc.at) / (7 * DAY)); // gentle recency boost
    hits.push({ doc, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

export const SEARCH_HELP: { op: string; desc: string }[] = [
  { op: 'domain:github', desc: 'Only this site' },
  { op: 'in:tabs', desc: 'tabs, workspaces, sessions, later, timeline, closed' },
  { op: 'is:duplicate', desc: 'pinned, audible, muted, duplicate, stale, asleep, grouped' },
  { op: 'note:deadline', desc: 'Inside your notes' },
  { op: 'older:7d', desc: 'Not used for a while (newer: too)' },
  { op: '"exact words"', desc: 'Exact phrase' },
  { op: '-word', desc: 'Exclude a word' },
  { op: '>', desc: 'Run a command' },
];
