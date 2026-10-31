import { useMemo, useState, type CSSProperties } from 'react';
import { Pencil, Play, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { describeRule } from '../../../shared/rules';
import { TAB_COLORS, type Rule, type RuleAction, type RuleMatchKind, type TabColor } from '../../../shared/types';
import { Empty, IconButton, Switch, colorVar } from '../../components/common';
import { Dialog, useDialogs, useToast } from '../../components/feedback';
import { plural } from '../../lib/actions';
import { useVault } from '../../lib/hooks';
import { rpc } from '../../lib/rpc';

type ActionType = RuleAction['type'];

const PRESETS: { label: string; match: { kind: RuleMatchKind; value: string }; action: RuleAction }[] = [
  { label: 'Group GitHub tabs', match: { kind: 'domain', value: 'github.com' }, action: { type: 'group', title: 'GitHub', color: 'purple' } },
  { label: 'Pin your mail', match: { kind: 'domain', value: 'mail.google.com' }, action: { type: 'pin' } },
  { label: 'Never sleep YouTube Music', match: { kind: 'domain', value: 'music.youtube.com' }, action: { type: 'protect' } },
];

export function RulesView() {
  const { vault, loading } = useVault();
  const toast = useToast();
  const dialogs = useDialogs();
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const names = useMemo(() => new Map(vault.workspaces.map((w) => [w.id, w.name])), [vault.workspaces]);

  const remove = async (rule: Rule) => {
    const ok = await dialogs.confirm({ title: 'Delete this rule?', body: describeRule(rule, nameOf(rule, names)), confirm: 'Delete', danger: true });
    if (ok) await toast.guard(rpc('rule.delete', { id: rule.id }));
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1 className="page-title">House <em>rules</em></h1>
            <div className="page-sub">Tell TabVault once, and it organizes new tabs as they open. Each rule fires once per tab and site, so it never fights you.</div>
          </div>
          <span className="spacer" />
          {vault.rules.length > 0 && (
            <button className="btn" onClick={() => void toast.guard(rpc('rule.applyNow', {})).then((n) => n !== undefined && toast.ok(n ? `Applied to ${plural(n, 'tab')}` : 'No open tabs match'))}>
              <Play size={14} />Apply to open tabs
            </button>
          )}
          <button className="btn btn-primary" onClick={() => setEditing('new')}><Plus size={14} />New rule</button>
        </div>
        {vault.rules.length ? (
          <div className="card">
            {vault.rules.map((rule) => (
              <div key={rule.id} className="rule-row">
                <Switch checked={rule.enabled} label={`Enable: ${describeRule(rule, nameOf(rule, names))}`} onChange={(enabled) => void toast.guard(rpc('rule.save', { id: rule.id, enabled, match: rule.match, action: rule.action }))} />
                <div className="rule-text">{describeRule(rule, nameOf(rule, names))}</div>
                {rule.action.type === 'group' && <span className="group-pill" style={{ '--ws': colorVar(rule.action.color) } as CSSProperties}>{rule.action.title}</span>}
                <IconButton label="Edit rule" onClick={() => setEditing(rule)}><Pencil size={14} /></IconButton>
                <IconButton label="Delete rule" className="is-danger" onClick={() => void remove(rule)}><Trash2 size={14} /></IconButton>
              </div>
            ))}
          </div>
        ) : !loading && (
          <div className="card">
            <Empty icon={<SlidersHorizontal size={20} />} title="No rules yet" action={<>
              {PRESETS.map((p) => (
                <button key={p.label} className="btn btn-sm" onClick={() => void toast.guard(rpc('rule.save', { match: p.match, action: p.action }))}>{p.label}</button>
              ))}
            </>}>
              Rules can group, pin, protect, or file tabs into a workspace by site, address or title. Start from one of these:
            </Empty>
          </div>
        )}
      </div>
      {editing && <RuleDialog rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

const nameOf = (rule: Rule, names: Map<string, string>) => (rule.action.type === 'workspace' ? names.get(rule.action.workspaceId) : undefined);

function RuleDialog({ rule, onClose }: { rule: Rule | null; onClose: () => void }) {
  const { vault } = useVault();
  const toast = useToast();
  const [kind, setKind] = useState<RuleMatchKind>(rule?.match.kind ?? 'domain');
  const [value, setValue] = useState(rule?.match.value ?? '');
  const [type, setType] = useState<ActionType>(rule?.action.type ?? 'group');
  const [title, setTitle] = useState(rule?.action.type === 'group' ? rule.action.title : '');
  const [color, setColor] = useState<TabColor>(rule?.action.type === 'group' ? rule.action.color : 'blue');
  const [workspaceId, setWorkspaceId] = useState(rule?.action.type === 'workspace' ? rule.action.workspaceId : (vault.workspaces[0]?.id ?? ''));

  const valid = value.trim().length > 0 && (type !== 'group' || title.trim().length > 0) && (type !== 'workspace' || !!workspaceId);
  const buildAction = (): RuleAction =>
    type === 'group' ? { type, title: title.trim(), color } : type === 'workspace' ? { type, workspaceId } : { type };

  const submit = async () => {
    if (!valid) return;
    await toast.guard(rpc('rule.save', { id: rule?.id, match: { kind, value: value.trim() }, action: buildAction() }));
    onClose();
  };

  return (
    <Dialog title={rule ? 'Edit rule' : 'New rule'} onClose={onClose}>
      <div className="field">
        <label className="field-label" htmlFor="rule-kind">When a tab’s…</label>
        <select id="rule-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as RuleMatchKind)}>
          <option value="domain">site is</option>
          <option value="url-contains">address contains</option>
          <option value="url-prefix">address starts with</option>
          <option value="title-contains">title contains</option>
        </select>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="rule-value">Value</label>
        <input
          id="rule-value" className="input" data-autofocus value={value} onChange={(e) => setValue(e.target.value)}
          placeholder={kind === 'domain' ? 'github.com' : kind === 'url-prefix' ? 'https://docs.google.com/' : 'pull request'}
        />
        {kind === 'domain' && <span className="faint" style={{ fontSize: 12 }}>Includes subdomains.</span>}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="rule-action">Then…</label>
        <select id="rule-action" className="input" value={type} onChange={(e) => setType(e.target.value as ActionType)}>
          <option value="group">Add to a tab group</option>
          <option value="pin">Pin it</option>
          <option value="protect">Never sleep it or call it stale</option>
          <option value="workspace" disabled={!vault.workspaces.length}>File into a workspace</option>
        </select>
      </div>
      {type === 'group' && (
        <>
          <div className="field">
            <label className="field-label" htmlFor="rule-group">Group name</label>
            <input id="rule-group" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Work" />
          </div>
          <div className="field">
            <span className="field-label">Colour</span>
            <div className="swatches" role="radiogroup" aria-label="Group colour">
              {TAB_COLORS.map((c) => (
                <button key={c} type="button" className="swatch" role="radio" aria-checked={c === color} aria-label={c} style={{ '--ws': colorVar(c) } as CSSProperties} onClick={() => setColor(c)} />
              ))}
            </div>
          </div>
        </>
      )}
      {type === 'workspace' && (
        <div className="field">
          <label className="field-label" htmlFor="rule-ws">Workspace</label>
          <select id="rule-ws" className="input" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            {vault.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <span className="faint" style={{ fontSize: 12 }}>Moves the tab to the workspace’s window if it’s open; otherwise adds the link to it.</span>
        </div>
      )}
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!valid} onClick={() => void submit()}>{rule ? 'Save' : 'Create rule'}</button>
      </div>
    </Dialog>
  );
}
