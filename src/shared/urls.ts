const RESTORABLE = new Set(['http:', 'https:', 'file:', 'ftp:', 'chrome:', 'edge:', 'brave:', 'chrome-extension:']);

/** Query params that identify a click or campaign, not the content of the page. */
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', 'yclid',
  'ref_src', 'ref_url', '_ga', '_gl', 'spm', 'vero_id', 'oly_anon_id', 'oly_enc_id',
]);

export function safeParse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Can this URL be saved and passed to chrome.tabs.create? Allowlist, so javascript:, data: etc. are out. */
export function isRestorable(url: string): boolean {
  const parsed = safeParse(url);
  return !!parsed && RESTORABLE.has(parsed.protocol);
}

export function isWebUrl(url: string): boolean {
  const parsed = safeParse(url);
  return parsed?.protocol === 'http:' || parsed?.protocol === 'https:';
}

export function isNewTabUrl(url: string): boolean {
  return (
    url === '' ||
    url === 'about:blank' ||
    url.startsWith('chrome://newtab') ||
    url.startsWith('chrome://new-tab-page') ||
    url.startsWith('edge://newtab')
  );
}

/** Tabs worth saving: restorable, and not an empty new tab page. */
export function isWorthSaving(url: string): boolean {
  return isRestorable(url) && !isNewTabUrl(url);
}

export function domainOf(url: string): string {
  const parsed = safeParse(url);
  if (!parsed) return '';
  if (parsed.protocol === 'file:') return 'local file';
  if (parsed.protocol === 'chrome:' || parsed.protocol === 'edge:' || parsed.protocol === 'brave:') return 'browser';
  if (parsed.protocol === 'chrome-extension:') return 'extension';
  if (!parsed.hostname) return parsed.protocol.replace(':', '');
  return parsed.hostname.replace(/^www\./, '').toLowerCase();
}

/**
 * Canonical key used for duplicate detection and for annotations: ignores
 * protocol, www., fragments (except #! and #/ routes), trailing slash, param
 * order and tracking params.
 */
export function urlKey(url: string): string {
  const parsed = safeParse(url);
  if (!parsed) return url.trim();
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url;
  const params = [...parsed.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()) && !k.toLowerCase().startsWith('utm_'))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  const path = parsed.pathname.replace(/\/+$/, '');
  const hash = parsed.hash.startsWith('#/') || parsed.hash.startsWith('#!') ? parsed.hash : '';
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.hostname.replace(/^www\./, '').toLowerCase()}${port}${path}${query}${hash}`;
}

/** A short human label for a URL: host + path, no protocol. */
export function displayUrl(url: string): string {
  const parsed = safeParse(url);
  if (!parsed) return url;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url;
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  return `${parsed.hostname.replace(/^www\./, '')}${path}${parsed.search}`;
}

/**
 * Chrome's local favicon cache. Never load tab.favIconUrl directly: that would
 * contact the site from an extension page (and CSP blocks it anyway).
 */
export function faviconUrl(pageUrl: string, size = 32): string {
  return `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`;
}

export function matchesDomain(host: string, domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/^www\./, '').replace(/^\*\./, '');
  return host === d || host.endsWith(`.${d}`);
}
