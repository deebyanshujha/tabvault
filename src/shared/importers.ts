import { isRestorable } from './urls';

export interface ParsedLink {
  url: string;
  title: string;
}

/**
 * Parses plain URL lists and OneTab exports ("url | title"). Blank lines separate
 * groups, which is how OneTab marks tab groups. Junk lines are ignored and counted.
 */
export function parseLinkList(text: string): { groups: ParsedLink[][]; ignored: number } {
  const groups: ParsedLink[][] = [];
  let current: ParsedLink[] = [];
  let ignored = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (current.length) groups.push(current);
      current = [];
      continue;
    }
    const sep = line.indexOf(' | ');
    const url = (sep >= 0 ? line.slice(0, sep) : line).trim();
    const title = sep >= 0 ? line.slice(sep + 3).trim() : '';
    if (isRestorable(url)) current.push({ url, title: title || url });
    else ignored++;
  }
  if (current.length) groups.push(current);
  return { groups, ignored };
}

/** Markdown for sharing a session or workspace somewhere else. */
export function toMarkdown(title: string, sections: { heading?: string; tabs: { url: string; title: string }[] }[]): string {
  const esc = (s: string) => s.replace(/([[\]\\])/g, '\\$1');
  const lines = [`# ${title}`, ''];
  for (const section of sections) {
    if (section.heading) lines.push(`## ${section.heading}`, '');
    for (const t of section.tabs) lines.push(`- [${esc(t.title || t.url)}](${t.url})`);
    lines.push('');
  }
  return lines.join('\n');
}
