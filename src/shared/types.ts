// Persisted data model. Everything here is stored locally in IndexedDB and is
// versioned through DB_VERSION (see storage/db.ts for migrations).

export type Id = string;

export const TAB_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;
export type TabColor = (typeof TAB_COLORS)[number];

export const WORKSPACE_ICONS = [
  'layers', 'code', 'book', 'graduation', 'briefcase', 'flask', 'film', 'music', 'user', 'home', 'rocket', 'compass',
] as const;
export type WorkspaceIcon = (typeof WORKSPACE_ICONS)[number];

export interface SavedGroup {
  key: string;
  title: string;
  color: TabColor;
  collapsed: boolean;
}

export interface SavedTab {
  id: Id;
  url: string;
  title: string;
  pinned: boolean;
  groupKey?: string;
  addedAt: number;
}

export interface Workspace {
  id: Id;
  name: string;
  color: TabColor;
  icon: WorkspaceIcon;
  items: SavedTab[];
  groups: SavedGroup[];
  /** When true, a window bound to this workspace keeps the saved list up to date. */
  autoSync: boolean;
  order: number;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
  deletedAt?: number;
}

export type SessionKind = 'manual' | 'auto' | 'closed-window' | 'recovery' | 'parked' | 'imported';

export interface SavedWindow {
  id: Id;
  tabs: SavedTab[];
  groups: SavedGroup[];
  focused: boolean;
  workspaceId?: Id;
}

export interface Session {
  id: Id;
  name: string;
  kind: SessionKind;
  windows: SavedWindow[];
  tabCount: number;
  /** Order-independent hash of the URLs; used to skip no-op snapshots. */
  fingerprint: string;
  keep: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
}

export type SessionSummary = Omit<Session, 'windows'> & {
  windowCount: number;
  topDomains: string[];
};

export type LaterState = 'queued' | 'snoozed' | 'done';

export interface LaterItem {
  id: Id;
  url: string;
  title: string;
  state: LaterState;
  snoozeUntil?: number;
  addedAt: number;
  doneAt?: number;
}

/** What TabVault knows about a URL: the user's note and where it was opened from. */
export interface Annotation {
  urlKey: string;
  url: string;
  note?: string;
  fromUrl?: string;
  fromTitle?: string;
  firstSeenAt: number;
  updatedAt: number;
}

export type RuleMatchKind = 'domain' | 'url-contains' | 'url-prefix' | 'title-contains';
export interface RuleMatch {
  kind: RuleMatchKind;
  value: string;
}
export type RuleAction =
  | { type: 'group'; title: string; color: TabColor }
  | { type: 'pin' }
  | { type: 'protect' }
  | { type: 'workspace'; workspaceId: Id };

export interface Rule {
  id: Id;
  name: string;
  enabled: boolean;
  match: RuleMatch;
  action: RuleAction;
  order: number;
  createdAt: number;
}

export interface DayActivity {
  day: string;
  focusSeconds: Record<string, number>;
  /** Focus seconds by clock hour, "0" to "23". */
  hours: Record<string, number>;
  /** How many times focus moved from one site to another. */
  switches: number;
  /** Longest unbroken stay on one site that ended or was checkpointed this day. */
  longest?: { domain: string; seconds: number };
  opened: number;
  closed: number;
  peakTabs: number;
}

export type ThemePref = 'system' | 'dark' | 'light';
export type BadgeMode = 'alerts' | 'tabs' | 'off';
export type WorkspaceOpenMode = 'new-window' | 'replace';

export interface Prefs {
  theme: ThemePref;
  badge: BadgeMode;
  workspaceOpenMode: WorkspaceOpenMode;
  /** Restore large sets of tabs asleep so they don't all stay in memory. */
  restoreAsleep: boolean;
  /** Minutes of inactivity before a tab is put to sleep. 0 disables. */
  autoSleepMinutes: number;
  /** Days without a visit before a tab counts as stale. */
  staleDays: number;
  /** Focus an already open tab instead of keeping a new duplicate. */
  focusExistingOnDuplicate: boolean;
  /** Time Machine: rolling automatic snapshots. */
  timeMachine: boolean;
  /** Record which page opened each tab. */
  provenance: boolean;
  /** Per-domain focus time and tab counts. Domain level only, stays local. */
  activity: boolean;
  /** Save a window's tabs automatically when it's closed. */
  closedWindowGuard: boolean;
  onboarded: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'system',
  badge: 'alerts',
  workspaceOpenMode: 'new-window',
  restoreAsleep: true,
  autoSleepMinutes: 0,
  staleDays: 7,
  focusExistingOnDuplicate: false,
  timeMachine: true,
  provenance: true,
  activity: true,
  closedWindowGuard: true,
  onboarded: false,
};

export interface RecoveryOffer {
  sessionId: Id;
  missing: number;
  total: number;
  at: number;
}

/** A unique URL seen in Time Machine snapshots, for "that tab I had last week". */
export interface TimelineEntry {
  url: string;
  title: string;
  lastSeenAt: number;
  sessionId: Id;
}

export interface VaultState {
  workspaces: Workspace[];
  sessions: SessionSummary[];
  /** Saved tabs of non-automatic sessions, flattened for search. */
  sessionTabs: { sessionId: Id; url: string; title: string }[];
  timeline: TimelineEntry[];
  later: LaterItem[];
  annotations: Annotation[];
  rules: Rule[];
  /** windowId (as string) → workspaceId */
  bindings: Record<string, Id>;
  recovery: RecoveryOffer | null;
  trash: { workspaces: Workspace[]; sessions: SessionSummary[] };
  quarantined: number;
}

export interface RestoreResult {
  opened: number;
  skipped: { url: string; reason: string }[];
  windowIds: number[];
}

export type Topic = 'workspaces' | 'sessions' | 'later' | 'annotations' | 'rules' | 'bindings' | 'recovery' | 'activity';
