import { describe, expect, it } from 'vitest';
import { fuzzyScore, parseDuration, parseQuery, prepare, search, type SearchDoc } from '../../src/shared/search';
import { DAY, HOUR } from '../../src/shared/time';

const doc = (over: Partial<SearchDoc> & { id: string }): ReturnType<typeof prepare> =>
  prepare({ kind: 'tab', title: '', url: '', domain: '', ...over });

const ids = (docs: ReturnType<typeof prepare>[], q: string, now = Date.now()) => search(docs, parseQuery(q), now).map((h) => h.doc.id);

describe('parseQuery', () => {
  it('parses operators, phrases and negation', () => {
    const q = parseQuery('domain:github.com is:pinned -is:muted "exact words" -nope title:foo older:7d in:tabs');
    expect(q.domains).toEqual(['github.com']);
    expect(q.flags).toEqual(['pinned']);
    expect(q.notFlags).toEqual(['muted']);
    expect(q.terms).toEqual([
      { text: 'exact words', negate: false, phrase: true },
      { text: 'nope', negate: true, phrase: false },
    ]);
    expect(q.titles).toEqual(['foo']);
    expect(q.olderThan).toBe(7 * DAY);
    expect(q.kinds).toEqual(['tab']);
  });

  it('treats unknown prefixes as plain text', () => {
    expect(parseQuery('http://a.com').terms[0]!.text).toBe('http://a.com');
  });

  it('ignores half-typed operators instead of blanking results', () => {
    expect(parseQuery('is:').terms).toEqual([]);
    expect(parseQuery('is:').isEmpty).toBe(true);
  });

  it('recognizes command mode', () => {
    const q = parseQuery('> dupl');
    expect(q.commandMode).toBe(true);
    expect(q.kinds).toEqual(['command']);
    expect(q.terms[0]!.text).toBe('dupl');
  });

  it('handles unbalanced quotes and empty input', () => {
    expect(parseQuery('"open quote').terms[0]!.text).toBe('open quote');
    expect(parseQuery('   ').isEmpty).toBe(true);
  });

  it('parses durations', () => {
    expect(parseDuration('2h')).toBe(2 * HOUR);
    expect(parseDuration('1w')).toBe(7 * DAY);
    expect(parseDuration('soon')).toBeNull();
  });
});

describe('fuzzyScore', () => {
  it('ranks exact word starts above mid-word matches', () => {
    expect(fuzzyScore('pull', 'pull requests')).toBeGreaterThan(fuzzyScore('pull', 'the bullpull thing'));
  });
  it('matches subsequences but rejects scattered noise', () => {
    expect(fuzzyScore('gh', 'github')).toBeGreaterThan(0);
    expect(fuzzyScore('xyz', 'github')).toBe(-1);
    expect(fuzzyScore('z', 'github')).toBe(-1);
    expect(fuzzyScore('gtb', 'a very long sentence about git and then much later the letter b')).toBe(-1);
  });
});

describe('search', () => {
  const docs = [
    doc({ id: 'a', title: 'Pull requests', url: 'https://github.com/pulls', domain: 'github.com', flags: ['pinned'], at: Date.now() }),
    doc({ id: 'b', title: 'Rust book', url: 'https://doc.rust-lang.org/book', domain: 'doc.rust-lang.org', note: 'read chapter on lifetimes', at: Date.now() - 10 * DAY }),
    doc({ id: 'c', kind: 'workspace', title: 'Rust project', url: '', domain: '', at: Date.now() }),
    doc({ id: 'd', kind: 'timeline', title: 'Rust playground', url: 'https://play.rust-lang.org', domain: 'play.rust-lang.org', at: Date.now() - 2 * DAY }),
    doc({ id: 'e', kind: 'command', title: 'Close duplicate tabs', url: '', domain: '', keywords: 'dedupe clean' }),
  ];

  it('searches titles, domains, urls and notes', () => {
    expect(ids(docs, 'pull')).toEqual(['a']);
    expect(ids(docs, 'github')).toEqual(['a']);
    expect(ids(docs, 'lifetimes')).toEqual(['b']);
  });

  it('ranks live things above history', () => {
    const result = ids(docs, 'rust');
    expect(result.indexOf('c')).toBeLessThan(result.indexOf('d'));
  });

  it('applies filters', () => {
    expect(ids(docs, 'domain:github')).toEqual(['a']);
    expect(ids(docs, 'rust -domain:play')).not.toContain('d');
    expect(ids(docs, 'is:pinned')).toEqual(['a']);
    expect(ids(docs, 'rust -book')).not.toContain('b');
    expect(ids(docs, 'in:timeline rust')).toEqual(['d']);
    expect(ids(docs, 'note:lifetimes')).toEqual(['b']);
    expect(ids(docs, '"rust book"')).toEqual(['b']);
  });

  it('filters by age', () => {
    expect(ids(docs, 'older:7d')).toEqual(['b']);
    expect(ids(docs, 'in:timeline newer:1d')).toEqual([]);
  });

  it('shows commands only when asked or matched', () => {
    expect(ids(docs, 'domain:github')).not.toContain('e');
    expect(ids(docs, '> dedupe')).toEqual(['e']);
    expect(ids(docs, 'duplicate')).toContain('e');
  });

  it('stays instant on a very large set', () => {
    const big = Array.from({ length: 20000 }, (_, i) =>
      doc({ id: `t${i}`, title: `Some page about topic number ${i} and things`, url: `https://site${i % 300}.example.com/path/${i}`, domain: `site${i % 300}.example.com`, at: Date.now() - i * 1000 }),
    );
    const start = performance.now();
    const hits = search(big, parseQuery('topic 19999'));
    const elapsed = performance.now() - start;
    expect(hits[0]!.doc.id).toBe('t19999');
    expect(elapsed).toBeLessThan(150);
  });
});
