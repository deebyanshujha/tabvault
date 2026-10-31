// Post-build guard: the promises in the README are checked against the built output.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = 'dist';
const errors = [];
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

// --- manifest ---
if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
if (manifest.host_permissions?.length) errors.push('host_permissions must stay empty');
if (manifest.content_scripts?.length) errors.push('no content scripts allowed');
if (manifest.externally_connectable) errors.push('externally_connectable must stay unset');
const allowed = new Set(['tabs', 'tabGroups', 'storage', 'unlimitedStorage', 'alarms', 'contextMenus', 'sessions', 'favicon', 'idle', 'sidePanel']);
for (const p of manifest.permissions ?? []) if (!allowed.has(p)) errors.push(`unexpected permission: ${p}`);
const csp = manifest.content_security_policy?.extension_pages ?? '';
for (const needle of ["connect-src 'none'", "script-src 'self'", "object-src 'none'"]) {
  if (!csp.includes(needle)) errors.push(`CSP is missing ${needle}`);
}

// --- referenced files exist ---
const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.side_panel.default_path,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
];
for (const file of referenced) if (!existsSync(join(DIST, file))) errors.push(`manifest references missing file: ${file}`);

// --- code rules ---
const files = walk(DIST);
const allowedUrlPrefixes = ['http://www.w3.org/', 'https://react.dev/', 'https://reactjs.org/', 'https://github.com/pulls', 'https://developer.mozilla.org/', 'https://scholar.google.com/', 'https://leetcode.com/problemset/', 'https://docs.google.com/', 'https://example.com', 'https://another.example', 'https://lucide.dev',
  // Input placeholder text and the "add https:// to a bare address" helper.
  'https://…', 'https://${'];
for (const file of files) {
  const rel = relative(DIST, file);
  if (rel.endsWith('.html')) {
    const html = readFileSync(file, 'utf8');
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) errors.push(`${rel}: inline <script>`);
    if (/\son[a-z]+=["']/i.test(html)) errors.push(`${rel}: inline event handler`);
    if (/(src|href)=["']https?:/i.test(html)) errors.push(`${rel}: remote resource`);
  }
  if (rel.endsWith('.js')) {
    const js = readFileSync(file, 'utf8');
    if (/\beval\s*\(/.test(js)) errors.push(`${rel}: eval()`);
    if (/\bnew\s+Function\s*\(/.test(js)) errors.push(`${rel}: new Function()`);
    if (/\b(XMLHttpRequest|WebSocket|EventSource)\b/.test(js)) errors.push(`${rel}: network API reference`);
    if (/\bfetch\s*\(/.test(js)) errors.push(`${rel}: fetch()`);
    if (/\bsendBeacon\b/.test(js)) errors.push(`${rel}: sendBeacon`);
    if (/importScripts\s*\(/.test(js)) errors.push(`${rel}: importScripts`);
    for (const [url] of js.matchAll(/https?:\/\/[^\s"'`)\\]+/g)) {
      if (!allowedUrlPrefixes.some((p) => url.startsWith(p))) errors.push(`${rel}: unexpected URL ${url}`);
    }
  }
}

if (errors.length) {
  console.error('dist verification FAILED:');
  for (const e of [...new Set(errors)]) console.error('  -', e);
  process.exit(1);
}
console.log(`dist verified: MV3, ${manifest.permissions.length} permissions, no host access, ${files.length} files, no eval/network/inline code.`);
