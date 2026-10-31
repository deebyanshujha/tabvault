import type {
  Annotation, DayActivity, LaterItem, Rule, RuleAction, SavedGroup, SavedTab, SavedWindow, Session, Workspace,
} from './types';
import { TAB_COLORS, WORKSPACE_ICONS } from './types';
import {
  array, boolean, nonEmpty, number, object, oneOf, optional, record, string, union, withDefault, type Parser,
} from './validate';
import { isRestorable } from './urls';
import { newId } from './ids';

export const urlParser: Parser<string> = (v, p) => {
  const s = nonEmpty(8192)(v, p);
  if (!isRestorable(s)) throw new Error(`Unsupported URL at ${p ?? 'root'}`);
  return s;
};

const idOrNew = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 100) : newId());

export const colorParser = oneOf(TAB_COLORS);
export const iconParser = oneOf(WORKSPACE_ICONS);

export const savedGroupParser = object({
  key: nonEmpty(100),
  title: withDefault(string(200), ''),
  color: withDefault(colorParser, 'grey'),
  collapsed: withDefault(boolean, false),
}) as Parser<SavedGroup>;

export const savedTabParser = object({
  id: idOrNew,
  url: urlParser,
  title: withDefault(string(1000), ''),
  pinned: withDefault(boolean, false),
  groupKey: optional(string(100)),
  addedAt: withDefault(number, 0),
}) as Parser<SavedTab>;

/** Keep what's usable in a list of tabs; one bad URL must not sink a whole workspace. */
const tabsLenient: Parser<SavedTab[]> = (v, p) => {
  if (!Array.isArray(v)) throw new Error(`Expected array at ${p ?? 'root'}`);
  const out: SavedTab[] = [];
  for (const entry of v) {
    try {
      out.push(savedTabParser(entry));
    } catch {
      // dropped: unusable URL
    }
  }
  return out;
};

export const workspaceParser = object({
  id: nonEmpty(100),
  name: nonEmpty(120),
  color: withDefault(colorParser, 'blue'),
  icon: withDefault(iconParser, 'layers'),
  items: withDefault(tabsLenient, []),
  groups: withDefault(array(savedGroupParser), []),
  autoSync: withDefault(boolean, true),
  order: withDefault(number, 0),
  createdAt: withDefault(number, 0),
  updatedAt: withDefault(number, 0),
  lastOpenedAt: optional(number),
  deletedAt: optional(number),
}) as Parser<Workspace>;

export const savedWindowParser = object({
  id: idOrNew,
  tabs: withDefault(tabsLenient, []),
  groups: withDefault(array(savedGroupParser), []),
  focused: withDefault(boolean, false),
  workspaceId: optional(string(100)),
}) as Parser<SavedWindow>;

export const sessionParser = object({
  id: nonEmpty(100),
  name: nonEmpty(200),
  kind: withDefault(oneOf(['manual', 'auto', 'closed-window', 'recovery', 'parked', 'imported'] as const), 'manual'),
  windows: withDefault(array(savedWindowParser), []),
  tabCount: withDefault(number, 0),
  fingerprint: withDefault(string(50), ''),
  keep: withDefault(boolean, false),
  createdAt: withDefault(number, 0),
  updatedAt: withDefault(number, 0),
  deletedAt: optional(number),
}) as Parser<Session>;

export const laterParser = object({
  id: nonEmpty(100),
  url: urlParser,
  title: withDefault(string(1000), ''),
  state: withDefault(oneOf(['queued', 'snoozed', 'done'] as const), 'queued'),
  snoozeUntil: optional(number),
  addedAt: withDefault(number, 0),
  doneAt: optional(number),
}) as Parser<LaterItem>;

export const annotationParser = object({
  urlKey: nonEmpty(9000),
  url: nonEmpty(8192),
  note: optional(string(5000)),
  fromUrl: optional(string(8192)),
  fromTitle: optional(string(1000)),
  firstSeenAt: withDefault(number, 0),
  updatedAt: withDefault(number, 0),
}) as Parser<Annotation>;

export const ruleMatchParser = object({
  kind: oneOf(['domain', 'url-contains', 'url-prefix', 'title-contains'] as const),
  value: nonEmpty(500),
});

export const ruleActionParser: Parser<RuleAction> = union<RuleAction>(
  object({ type: oneOf(['group'] as const), title: string(100), color: colorParser }) as Parser<RuleAction>,
  object({ type: oneOf(['pin'] as const) }) as Parser<RuleAction>,
  object({ type: oneOf(['protect'] as const) }) as Parser<RuleAction>,
  object({ type: oneOf(['workspace'] as const), workspaceId: nonEmpty(100) }) as Parser<RuleAction>,
);

export const ruleParser = object({
  id: nonEmpty(100),
  name: withDefault(string(200), ''),
  enabled: withDefault(boolean, true),
  match: ruleMatchParser,
  action: ruleActionParser,
  order: withDefault(number, 0),
  createdAt: withDefault(number, 0),
}) as Parser<Rule>;

export const activityParser = object({
  day: nonEmpty(20),
  focusSeconds: withDefault(record(number), {}),
  hours: withDefault(record(number), {}),
  switches: withDefault(number, 0),
  longest: optional(object({ domain: nonEmpty(300), seconds: number })),
  opened: withDefault(number, 0),
  closed: withDefault(number, 0),
  peakTabs: withDefault(number, 0),
}) as Parser<DayActivity>;
