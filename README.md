# TabVault

A local-first browser workspace for Chrome. Give each thing you're doing its own set of tabs, switch between them without losing any, and search everything you have open or had open recently. Nothing leaves your device.

## Why, if Chrome already has bookmarks, tab groups and session restore?

Those features store things. TabVault keeps a browsing context *alive*:

| You want to… | Chrome | TabVault |
|---|---|---|
| Keep a project's tabs up to date | Re-bookmark by hand | A workspace bound to a window saves itself as you browse |
| Change context | Open another window and let the old one pile up | Swap the whole window; the old tabs are saved first |
| Find that tab from last week | Dig through history | Time Machine snapshots are searchable, without the `history` permission |
| Recover after a restart | Works only if restore was on | Detects which tabs didn't come back and offers exactly those |
| Remember why a tab is open | No | Searchable notes, plus which page opened it |

## Features

**Palette (popup, `Alt+K`).** Instant search across open tabs, workspaces, saved sessions, Later, recently closed and Time Machine. `Tab` changes scope, `Ctrl+K` shows every action for a result, `>` runs commands.

Query syntax: `domain:github`, `in:tabs|workspaces|sessions|later|timeline|closed`, `is:duplicate|stale|asleep|pinned|audible|muted|grouped`, `note:deadline`, `title:`, `url:`, `group:`, `older:7d`, `newer:1h`, `"exact phrase"`, `-exclude`.

**Workspaces.** Named, coloured, with templates. Open in a new window, switch the current window (tabs are saved first), or add to the window. Bound windows sync automatically and re-bind after a restart when their tabs come back.

**Session Vault.** Named sessions with automatic names, preview, restore all or only ticked tabs, tab groups and pins preserved, promote to a workspace, copy as Markdown. Deleted items stay in Trash for 30 days.

**Protection that runs by itself.** Time Machine (every snapshot for an hour, hourly for a day, daily for two weeks), closed-window capture, restart recovery, undo on closes and deletes.

**Open tabs page.** Group by window or site, sort, filter, multi-select with keyboard or mouse, bulk close, move, group, pin, sleep, save. Drag tabs between windows or onto a workspace. Virtualized for large sessions.

**Housekeeping.** Duplicate detection that ignores tracking parameters, stale-tab review, tab sleeping via Chrome's own discarding, optional auto-sleep, suggestions on the Today page. Nothing closes without you asking.

**Later.** A reading queue. Snooze a page and it reopens at the chosen time.

**Rules.** When a site, address or title matches: group, pin, protect from sleep, or file into a workspace. Each rule fires once per tab and site, so it never fights your manual changes.

**Insights.** A chart of where your time went by site, a weekday-by-hour map of when you browse, and facts such as your peak hour, longest unbroken stretch, how often you change site, new sites and your change from the previous period. Counted per site, never per page; local only, 90-day retention, can be turned off.

**Also.** Side panel with vertical tabs, context-menu items, JSON backup and restore, OneTab and URL-list import, light and dark themes.

### Keyboard

| Anywhere in Chrome | |
|---|---|
| `Alt+K` | Open TabVault |
| `Alt+Q` | Jump to previously used tab |
| `Alt+Shift+S` | Send tab to Later |
| `Alt+Shift+D` | Open dashboard |

Change these at `chrome://extensions/shortcuts`. In the dashboard: `Ctrl+K` palette, `/` search, `G` then a letter to navigate, `?` for the full list. On the Open tabs page: arrows or `J`/`K` move, `Space` selects, `Shift`+arrows extends, `Enter` switches, `Del` closes.

## Install

Requires Node 20+ and Chrome 121+.

```sh
npm install
npm run build
```

Then in Chrome:

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `dist` folder.
4. Pin TabVault to the toolbar. The dashboard opens on first install.

If `Alt+K` doesn't work, another extension has claimed it. Set it at `chrome://extensions/shortcuts`.

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Rebuild on change (then click reload on the extension) |
| `npm run build` | Production build, then verify `dist` |
| `npm run typecheck` | TypeScript, strict |
| `npm run lint` | ESLint |
| `npm test` | Unit and service tests (fake `chrome.*`, fake IndexedDB) |
| `npm run test:e2e` | Build, then drive the real extension in Chromium |
| `npm run check` | Typecheck, lint, unit tests, build |
| `npm run icons` | Regenerate toolbar icons |
| `node scripts/screenshots.mjs [dir] [dark\|light]` | Capture every screen with demo data, offline |

E2E needs a browser once: `npx playwright install chromium`. It uses Playwright's Chromium because branded Chrome no longer accepts `--load-extension`.

## Architecture

```
src/
  shared/       Pure logic, no chrome.*: search, duplicates, retention, rules, URL handling, schemas
  storage/      IndexedDB layer (transactions, migrations, quarantine) and prefs
  background/   Service worker
    index.ts      Event listeners, debounced capture, alarms, boot detection
    router.ts     The typed, validated RPC table: the only way in from UI pages
    workspaces, sessions, restore, tabs, later, rules, activity, backup, menus, badge
    runtime.ts    State in chrome.storage.session (bindings, MRU, undo)
  ui/           React: palette (popup, side panel, dashboard modal), dashboard views, components
tests/          unit/ and e2e/
scripts/        verify-dist, icons, screenshots
```

**Data flow.** UI pages read tabs directly from `chrome.tabs`, which is instant and doesn't wake the worker. All vault reads and writes go through typed RPC to the worker, which broadcasts `changed` topics so open pages refresh.

**Surviving MV3.** The worker can die at any moment, so:
- Listeners register synchronously at the top level.
- State that must outlive the worker is in `storage.session` (until browser restart) or IndexedDB (forever).
- Timers are only a fast path; a 5-minute alarm sweeps anything a killed worker left undone.
- An empty `storage.session` is what identifies a new browser run. Everything that writes live state awaits boot first, so the last run's state can't be overwritten before recovery has read it.

**Key decisions**

- **Saving before closing.** A window switch saves the current tabs, opens the new ones, and only then closes the old. If none of the new tabs can open, the window is left as it was.
- **An empty capture never overwrites.** A closing window, or one with only new-tab pages, can't wipe a workspace or the recovery state.
- **Corrupt data is quarantined, not deleted.** Every record is parsed on read. One bad URL drops one tab, not a workspace. One bad record moves aside and the rest load.
- **No regex in rules.** Patterns would run on every navigation and can come from imported files, which is a ReDoS risk for little benefit.
- **Native discarding instead of a suspender page.** Redirecting tabs through an extension page risks losing them if the extension is removed. Sleeping uses `chrome.tabs.discard`, after the URL has committed.
- **Small dependency list.** React and lucide-react (tree-shaken) at runtime, plus locally bundled fonts. Storage, validation, search and the virtual list are small and in-repo.

**Schema changes.** Add an entry to `MIGRATIONS` in `src/storage/db.ts` and bump `DB_VERSION`. Migrations run inside the upgrade transaction, so a failure leaves the old database intact. Backups record their schema version, and a backup from a newer version is refused.

## Permissions

| Permission | Why |
|---|---|
| `tabs` | Read tab titles and addresses to list, search and save them |
| `tabGroups` | Create, read and restore tab groups |
| `sessions` | List and reopen Chrome's recently closed tabs |
| `storage`, `unlimitedStorage` | Keep data on this device, safe from automatic eviction |
| `alarms` | Wake for snapshots and snoozes without running constantly |
| `contextMenus` | Right-click "Save to Later" and "Add to workspace" |
| `favicon` | Show icons from Chrome's local cache without contacting sites |
| `idle` | Stop counting focus time when you step away |
| `sidePanel` | The optional vertical tab list |

No host permissions and no content scripts: TabVault can't read or change page contents. Incognito is disabled in the manifest.

## Privacy

- No account, server, analytics or telemetry.
- Data lives in IndexedDB and `chrome.storage` on this device. It leaves only if you export a file.
- The extension's content security policy sets `connect-src 'none'`, so Chrome itself blocks its pages and service worker from making network requests. `npm run build` also fails if network APIs, `eval` or inline scripts appear in the output.
- Favicons come from Chrome's local cache, never from the site. Fonts are bundled.
- Web pages can't message the extension: it has no `externally_connectable`, and the worker rejects any sender that isn't its own page.

**What is stored:** titles and addresses of saved and snapshotted tabs (including the rolling Time Machine history), your notes, which page opened each tab, and per-site focus time. Treat a backup file as sensitive, since it contains browsing data. Time Machine, provenance and insights can each be turned off, and Settings can erase everything.

**The tracking caveat:** opening a saved tab is ordinary browsing, so that site sees a normal visit.

## Known limitations

- **Restoring asleep still loads each page briefly.** Chrome can't create a tab asleep, so tabs load until their URL commits and are then discarded, in batches.
- **Window ids change across restarts.** Workspaces re-bind by matching tabs (60% overlap or more). A window that has drifted far from its saved list comes back as an ordinary window, with the saved list intact.
- **Window size and position aren't restored.**
- **Recovery timing.** The check waits 30 seconds so Chrome's own restore can finish. Losing a single tab isn't flagged.
- **Backups don't run automatically.** Writing to disk unprompted would need the `downloads` permission. Time Machine covers in-browser recovery, but a backup is what survives uninstalling, because uninstalling deletes extension data.
- **Duplicate detection is heuristic.** Plain `#fragments` are treated as the same page, and sites that encode the page in an unusual parameter may not match.
- **Shortcut labels show `Ctrl`.** On macOS the shortcuts work with `Cmd`, but the hints still say `Ctrl`.
- **Chromium browsers other than Chrome are untested.**
