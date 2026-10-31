// Page titles carry a lot besides the page: unread counters, the site's name, its tagline.
// These helpers keep the part that says what this tab actually is. Display only: search and
// saved data still use the full title.

import { displayUrl, domainOf, safeParse } from './urls';

const COUNTER = /^\s*(?:\(\d+\+?\)|\[\d+\+?\]|[•●])\s*/;
const SEPARATOR = /\s+[-–—|·•»]\s+/g;
const SEARCH_PARAMS = ['q', 'query', 'search_query', 'search', 'k'];

const compact = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
const wordCount = (text: string) => text.trim().split(/\s+/).length;

/** The name part of a host: youtube for www.youtube.com, bbc for www.bbc.co.uk. */
function siteLabel(url: string): string {
  const parsed = safeParse(url);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return '';
  const parts = parsed.hostname.split('.');
  if (parts.length < 2 || /^[\d.]+$/.test(parsed.hostname)) return '';
  const countrySuffix = parts.length > 2 && parts[parts.length - 2]!.length <= 3 && parts[parts.length - 1]!.length === 2;
  return compact(parts[parts.length - (countrySuffix ? 3 : 2)]!);
}

/** "Haikyu!! Episode 5 | Anikoto" and "(3) Haikyu!! Episode 5" both become "Haikyu!! Episode 5". */
export function cleanTitle(title: string, url: string): string {
  if (title === url) return displayUrl(url);
  const text = title.replace(COUNTER, '').trim() || title.trim();
  const site = siteLabel(url);
  if (!site) return text;

  const breaks = [...text.matchAll(SEPARATOR)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  if (!breaks.length) return text;
  const segments = breaks.map((b, i) => text.slice(i ? breaks[i - 1]!.end : 0, b.start));
  segments.push(text.slice(breaks[breaks.length - 1]!.end));

  const namesSite = (segment: string) => {
    const c = compact(segment);
    return c === site || (c.length >= 3 && site.startsWith(c));
  };
  if (namesSite(segments[0]!)) return text.slice(breaks[0]!.end);
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i]!;
    if (namesSite(segment) || (site.length >= 3 && compact(segment).startsWith(site) && wordCount(segment) <= 3)) {
      return text.slice(0, breaks[i - 1]!.start);
    }
  }
  // A closing slogan such as "Official Uber Site".
  const last = segments[segments.length - 1]!;
  if (site.length >= 3 && compact(last).includes(site) && wordCount(last) <= 4) return text.slice(0, breaks[breaks.length - 1]!.start);
  return text;
}

const readable = (segment: string) => {
  let text = segment;
  try {
    text = decodeURIComponent(segment);
  } catch {
    // Not valid percent-encoding: show it as written.
  }
  text = text.replace(/[-_+]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const looksLikeId = (segment: string) => /^[\da-f-]{6,}$/i.test(segment) || (/\d/.test(segment) && segment.length >= 8);

/** What the address says about a page, for telling apart tabs whose titles match. */
export function pageHint(url: string): string {
  const parsed = safeParse(url);
  if (!parsed) return '';
  for (const key of SEARCH_PARAMS) {
    const value = parsed.searchParams.get(key)?.trim();
    if (value) return `Search: ${value}`;
  }
  const path = parsed.pathname.split('/').filter(Boolean);
  if (!path.length) return 'Home';
  const named = [...path].reverse().find((segment) => !looksLikeId(segment));
  return named ? readable(named) : '';
}

const labelKey = (title: string, url: string) => `${domainOf(url)}|${cleanTitle(title, url).toLowerCase()}`;

/** Finds tabs that would read the same in a list: same site, same cleaned title. */
export function repeatedLabels(tabs: { title: string; url: string }[]): (title: string, url: string) => boolean {
  const counts = new Map<string, number>();
  for (const { title, url } of tabs) {
    const key = labelKey(title, url);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (title, url) => (counts.get(labelKey(title, url)) ?? 0) > 1;
}
