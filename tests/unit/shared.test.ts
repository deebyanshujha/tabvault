import { describe, expect, it } from 'vitest';
import { displayUrl, domainOf, isRestorable, isWorthSaving, matchesDomain, urlKey } from '../../src/shared/urls';
import { analyzeClutter, findDuplicates, type ClutterTab } from '../../src/shared/clutter';
import { autoSessionName, fingerprintOf, missingAfterRestart, overlapRatio, snapshotsToPrune } from '../../src/shared/sessions';
import { describeRule, isProtectedByRules, matchesRule, rulesFor } from '../../src/shared/rules';
import { parseLinkList, toMarkdown } from '../../src/shared/importers';
import { DAY, HOUR, MINUTE, dayKey, formatDuration, snoozeOptions } from '../../src/shared/time';
import { addToHours, emptyDay, summarize } from '../../src/shared/insights';
import { activityParser } from '../../src/shared/schemas';
import type { DayActivity, Rule, SavedWindow } from '../../src/shared/types';

describe('urls', () => {
  it('allows ordinary pages and rejects script-bearing schemes', () => {
    for (const ok of ['https://a.com', 'http://a.com/x?y=1', 'file:///c:/x.pdf', 'chrome://settings']) expect(isRestorable(ok)).toBe(true);
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<script>1</script>', 'blob:https://a/1', 'not a url', '', 'vbscript:x']) {
      expect(isRestorable(bad)).toBe(false);
    }
  });

  it('does not treat new tab pages as worth saving', () => {
    expect(isWorthSaving('chrome://newtab/')).toBe(false);
    expect(isWorthSaving('about:blank')).toBe(false);
    expect(isWorthSaving('https://a.com')).toBe(true);
  });

  it('canonicalizes so duplicates are found across trivial differences', () => {
    const same = [
      'https://www.example.com/a/', 'http://example.com/a', 'https://EXAMPLE.com/a#section',
      'https://example.com/a?utm_source=x&fbclid=123', 'https://example.com/a?gclid=9',
    ];
    expect(new Set(same.map(urlKey)).size).toBe(1);
  });

  it('keeps differences that change the page', () => {
    expect(urlKey('https://a.com/x?id=1')).not.toBe(urlKey('https://a.com/x?id=2'));
    expect(urlKey('https://a.com/x')).not.toBe(urlKey('https://a.com/y'));
    expect(urlKey('https://a.com:8080/x')).not.toBe(urlKey('https://a.com/x'));
    // Hash routing is a real difference; plain anchors are not.
    expect(urlKey('https://a.com/#/inbox')).not.toBe(urlKey('https://a.com/#/sent'));
    expect(urlKey('https://a.com/?b=2&a=1')).toBe(urlKey('https://a.com/?a=1&b=2'));
  });

  it('survives junk input', () => {
    expect(urlKey('%%%')).toBe('%%%');
    expect(domainOf('%%%')).toBe('');
    expect(displayUrl('%%%')).toBe('%%%');
  });

  it('labels domains sensibly', () => {
    expect(domainOf('https://www.github.com/a')).toBe('github.com');
    expect(domainOf('chrome://settings')).toBe('browser');
    expect(domainOf('file:///x.pdf')).toBe('local file');
  });

  it('matches subdomains but not lookalikes', () => {
    expect(matchesDomain('docs.github.com', 'github.com')).toBe(true);
    expect(matchesDomain('github.com', 'www.github.com')).toBe(true);
    expect(matchesDomain('notgithub.com', 'github.com')).toBe(false);
  });
});

const tab = (over: Partial<ClutterTab> & { id: number }): ClutterTab => ({
  windowId: 1, url: `https://site.com/${over.id}`, title: 't', pinned: false, active: false, audible: false, lastAccessed: Date.now(), ...over,
});

describe('clutter', () => {
  it('keeps the active copy and offers the others', () => {
    const [set] = findDuplicates([
      tab({ id: 1, url: 'https://a.com/x' }), tab({ id: 2, url: 'https://a.com/x/', active: true }), tab({ id: 3, url: 'https://www.a.com/x' }),
    ]);
    expect(set!.keep.id).toBe(2);
    expect(set!.extras.map((t) => t.id).sort()).toEqual([1, 3]);
  });

  it('prefers the most recently used copy when none is active', () => {
    const [set] = findDuplicates([tab({ id: 1, url: 'https://a.com', lastAccessed: 100 }), tab({ id: 2, url: 'https://a.com', lastAccessed: 200 })]);
    expect(set!.keep.id).toBe(2);
  });

  it('never offers pinned or active copies for closing', () => {
    const sets = findDuplicates([tab({ id: 1, url: 'https://a.com', pinned: true }), tab({ id: 2, url: 'https://a.com', active: true })]);
    expect(sets).toEqual([]);
  });

  it('does not count new tab pages as duplicates', () => {
    expect(findDuplicates([tab({ id: 1, url: 'chrome://newtab/' }), tab({ id: 2, url: 'chrome://newtab/' })])).toEqual([]);
  });

  it('flags stale tabs but spares pinned, active, playing and protected ones', () => {
    const old = Date.now() - 10 * DAY;
    const report = analyzeClutter(
      [
        tab({ id: 1, lastAccessed: old }), tab({ id: 2, lastAccessed: old, pinned: true }), tab({ id: 3, lastAccessed: old, active: true }),
        tab({ id: 4, lastAccessed: old, audible: true }), tab({ id: 5, lastAccessed: old, url: 'https://keep.me/' }), tab({ id: 6 }),
      ],
      { staleDays: 7, isProtected: (t) => t.url.includes('keep.me') },
    );
    expect(report.stale.map((t) => t.id)).toEqual([1]);
  });

  it('finds hoards and single-tab windows', () => {
    const report = analyzeClutter(
      [...[1, 2, 3, 4, 5].map((id) => tab({ id })), tab({ id: 6, windowId: 2, url: 'https://x.com' })],
      { staleDays: 7 },
    );
    expect(report.hoards[0]).toMatchObject({ domain: 'site.com' });
    expect(report.singleTabWindows).toEqual([2]);
  });
});

describe('Time Machine retention', () => {
  const now = 1_700_000_000_000;
  it('keeps everything from the last hour', () => {
    const snaps = [1, 2, 3].map((i) => ({ id: `s${i}`, createdAt: now - i * 5 * MINUTE }));
    expect(snapshotsToPrune(snaps, now)).toEqual([]);
  });
  it('thins to one per hour, keeping the newest in each', () => {
    const base = Math.floor((now - 5 * HOUR) / HOUR) * HOUR;
    const snaps = [{ id: 'old', createdAt: base + 5 * MINUTE }, { id: 'new', createdAt: base + 30 * MINUTE }];
    expect(snapshotsToPrune(snaps, now)).toEqual(['old']);
  });
  it('thins to one per day, and drops anything past two weeks', () => {
    const base = Math.floor((now - 3 * DAY) / DAY) * DAY;
    const snaps = [
      { id: 'a', createdAt: base + HOUR }, { id: 'b', createdAt: base + 2 * HOUR }, { id: 'ancient', createdAt: now - 20 * DAY },
    ];
    expect(snapshotsToPrune(snaps, now).sort()).toEqual(['a', 'ancient']);
  });
  it('never prunes a kept snapshot', () => {
    expect(snapshotsToPrune([{ id: 'k', createdAt: now - 100 * DAY, keep: true }], now)).toEqual([]);
  });
});

describe('session helpers', () => {
  const win = (urls: string[]): SavedWindow => ({ id: 'w', focused: false, groups: [], tabs: urls.map((url, i) => ({ id: String(i), url, title: url, pinned: false, addedAt: 0 })) });

  it('fingerprint ignores order but notices changes', () => {
    expect(fingerprintOf([win(['https://a.com', 'https://b.com'])])).toBe(fingerprintOf([win(['https://b.com', 'https://a.com'])]));
    expect(fingerprintOf([win(['https://a.com'])])).not.toBe(fingerprintOf([win(['https://b.com'])]));
  });

  it('counts missing tabs as a multiset after restart', () => {
    const prev = [{ url: 'https://a.com' }, { url: 'https://a.com' }, { url: 'https://b.com' }];
    expect(missingAfterRestart(prev, [{ url: 'https://a.com/' }, { url: 'https://b.com' }])).toEqual([{ url: 'https://a.com' }]);
    expect(missingAfterRestart(prev, [])).toHaveLength(3);
    expect(missingAfterRestart(prev, prev)).toHaveLength(0);
  });

  it('names sessions from their content', () => {
    const name = autoSessionName(['https://github.com/a', 'https://github.com/b', 'https://docs.rs/x', 'https://a.io', 'https://b.io']);
    expect(name).toMatch(/^github\.com & /);
    expect(name).toContain('+2');
    expect(autoSessionName([])).toMatch(/^Session · /);
  });

  it('measures overlap for re-binding windows', () => {
    expect(overlapRatio(['https://a.com', 'https://b.com'], ['https://a.com/', 'https://c.com'])).toBe(0.5);
    expect(overlapRatio([], ['https://a.com'])).toBe(0);
  });
});

describe('rules', () => {
  const rule = (over: Partial<Rule>): Rule => ({ id: 'r', name: '', enabled: true, match: { kind: 'domain', value: 'github.com' }, action: { type: 'pin' }, order: 0, createdAt: 0, ...over });
  it('matches each kind', () => {
    expect(matchesRule({ kind: 'domain', value: 'github.com' }, { url: 'https://gist.github.com/x' })).toBe(true);
    expect(matchesRule({ kind: 'domain', value: 'github.com' }, { url: 'https://github.com.evil.io/' })).toBe(false);
    expect(matchesRule({ kind: 'url-contains', value: 'PULL' }, { url: 'https://x.com/pull/1' })).toBe(true);
    expect(matchesRule({ kind: 'url-prefix', value: 'https://x.com/a' }, { url: 'https://x.com/b' })).toBe(false);
    expect(matchesRule({ kind: 'title-contains', value: 'bug' }, { url: 'https://x.com', title: 'A Bug' })).toBe(true);
    expect(matchesRule({ kind: 'domain', value: '  ' }, { url: 'https://x.com' })).toBe(false);
  });
  it('honours enabled and order', () => {
    const rules = [rule({ id: 'b', order: 2 }), rule({ id: 'a', order: 1 }), rule({ id: 'off', enabled: false })];
    expect(rulesFor(rules, { url: 'https://github.com' }).map((r) => r.id)).toEqual(['a', 'b']);
  });
  it('recognizes protection', () => {
    expect(isProtectedByRules([rule({ action: { type: 'protect' } })], { url: 'https://github.com' })).toBe(true);
    expect(isProtectedByRules([rule({ action: { type: 'pin' } })], { url: 'https://github.com' })).toBe(false);
  });
  it('describes itself in plain words', () => {
    expect(describeRule(rule({ action: { type: 'group', title: 'Code', color: 'blue' } }))).toBe('When site is github.com, group as “Code”');
  });
});

describe('importers', () => {
  it('parses OneTab format with groups, and ignores junk and unsafe schemes', () => {
    const { groups, ignored } = parseLinkList('https://a.com | Page A\nhttps://b.com\n\n\njavascript:alert(1) | x\nnonsense\nhttps://c.com | C | with pipe');
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual([{ url: 'https://a.com', title: 'Page A' }, { url: 'https://b.com', title: 'https://b.com' }]);
    expect(groups[1]![0]!.title).toBe('C | with pipe');
    expect(ignored).toBe(2);
  });
  it('handles CRLF and empty input', () => {
    expect(parseLinkList('https://a.com\r\n\r\nhttps://b.com').groups).toHaveLength(2);
    expect(parseLinkList('').groups).toEqual([]);
  });
  it('writes Markdown with escaped titles', () => {
    const md = toMarkdown('T', [{ heading: 'W', tabs: [{ url: 'https://a.com', title: 'a [b]' }] }]);
    expect(md).toContain('- [a \\[b\\]](https://a.com)');
  });
});

describe('time', () => {
  it('formats durations', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(600)).toBe('10m');
    expect(formatDuration(3660)).toBe('1h 1m');
    expect(formatDuration(7200)).toBe('2h');
  });
  it('offers only snooze times in the future, in order of the day', () => {
    const late = new Date(2026, 0, 7, 22, 0).getTime();
    const options = snoozeOptions(late);
    expect(options.every((o) => o.at > late)).toBe(true);
    expect(options.map((o) => o.id)).not.toContain('evening');
    const morning = snoozeOptions(new Date(2026, 0, 7, 9, 0).getTime());
    expect(morning.map((o) => o.id)).toContain('evening');
  });
});

describe('insights', () => {
  const NOW = new Date(2026, 9, 28, 15, 30).getTime(); // a Wednesday
  const key = (daysAgo: number) => dayKey(NOW - daysAgo * DAY);
  const day = (daysAgo: number, focusSeconds: Record<string, number>, extra: Partial<DayActivity> = {}): DayActivity => ({ ...emptyDay(key(daysAgo)), focusSeconds, ...extra });

  it('splits a span across the clock hours it covered', () => {
    const end = new Date(2026, 9, 28, 15, 10).getTime();
    expect(addToHours({ 15: 5 }, end, 20 * 60)).toEqual({ 15: 5 + 600, 14: 600 });
    const onTheHour = new Date(2026, 9, 28, 15, 0, 0, 0).getTime();
    expect(addToHours({}, onTheHour, 60)).toEqual({ 14: 60 });
  });

  it('keeps five sites and folds the rest into Other', () => {
    const focus = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) => [n + '.com', 700 - i * 100]));
    const s = summarize([day(0, focus)], 7, NOW);
    expect(s.slices).toHaveLength(6);
    expect(s.slices[5]).toMatchObject({ label: 'Other', count: 2, seconds: 300 });
    expect(s.slices.reduce((n, x) => n + x.share, 0)).toBeCloseTo(1);
    expect(s.seconds).toBe(2800);
    expect(s.topThreeShare).toBeCloseTo(1800 / 2800);
  });

  it('keeps a site’s colour when the range changes', () => {
    const data = [day(0, { recent: 100 }), day(20, { older: 900 })];
    const week = summarize(data, 7, NOW).slices.find((x) => x.domain === 'recent')!;
    const month = summarize(data, 30, NOW).slices.find((x) => x.domain === 'recent')!;
    expect(week.slot).toBe(month.slot);
    expect(new Set(summarize(data, 30, NOW).slices.map((x) => x.slot)).size).toBe(2);
  });

  it('compares with the period before, and says nothing without one', () => {
    expect(summarize([day(0, { a: 150 }), day(8, { a: 100 })], 7, NOW).change).toBe(50);
    expect(summarize([day(0, { a: 150 })], 7, NOW).change).toBeNull();
  });

  it('finds new sites only when there is history to compare against', () => {
    expect(summarize([day(0, { a: 1, b: 1 }), day(10, { a: 1 })], 7, NOW).newSites).toEqual(['b']);
    expect(summarize([day(0, { a: 1 })], 7, NOW).newSites).toBeNull();
  });

  it('places time on the weekday and hour grid, Monday first', () => {
    const s = summarize([day(0, { a: 60 }, { hours: { 15: 60 } }), day(1, { a: 90 }, { hours: { 9: 90 } })], 7, NOW);
    expect(s.grid[2]![15]).toBe(60);
    expect(s.grid[1]![9]).toBe(90);
    expect(s.peakHour).toEqual({ hour: 9, seconds: 90 });
    expect(s.gridMax).toBe(90);
  });

  it('counts a streak that today hasn’t joined yet, and stops at a gap', () => {
    expect(summarize([day(1, { a: 1 }), day(2, { a: 1 }), day(4, { a: 1 })], 7, NOW).streak).toBe(2);
    expect(summarize([day(0, { a: 1 }), day(1, { a: 1 })], 7, NOW).streak).toBe(2);
    expect(summarize([], 7, NOW).streak).toBe(0);
  });

  it('only reports a switching rhythm with enough switches', () => {
    expect(summarize([day(0, { a: 600 }, { switches: 2 })], 7, NOW).switchEvery).toBeNull();
    expect(summarize([day(0, { a: 600 }, { switches: 3 })], 7, NOW).switchEvery).toBe(200);
  });

  it('reads old records that predate the hourly fields', () => {
    const parsed = activityParser({ day: '2026-01-01', focusSeconds: { 'a.com': 5 }, opened: 1, closed: 0, peakTabs: 2 });
    expect(parsed).toMatchObject({ hours: {}, switches: 0 });
    expect(parsed.longest).toBeUndefined();
    expect(summarize([parsed], 7, new Date(2026, 0, 1, 12).getTime()).seconds).toBe(5);
  });
});
