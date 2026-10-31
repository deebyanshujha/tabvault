import { useMemo, useState } from 'react';
import { BellOff, Check, CheckCheck, Clock, Link2, ListPlus, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react';
import type { LaterItem } from '../../../shared/types';
import { displayUrl, isRestorable, urlKey } from '../../../shared/urls';
import { formatDateTime, snoozeOptions, timeAgo, timeUntil } from '../../../shared/time';
import { Dropdown, Empty, Favicon, IconButton, Kbd, Segmented } from '../../components/common';
import { useDialogs, useToast } from '../../components/feedback';
import { annotationMap } from '../../lib/docs';
import { useVault, type LiveData } from '../../lib/hooks';
import { rpc } from '../../lib/rpc';

type Filter = 'queued' | 'snoozed' | 'done';

export function LaterView({ live }: { live: LiveData }) {
  const { vault, loading } = useVault();
  const toast = useToast();
  const dialogs = useDialogs();
  const [filter, setFilter] = useState<Filter>('queued');
  const notes = useMemo(() => annotationMap(vault.annotations), [vault.annotations]);
  const counts = useMemo(() => {
    const out = { queued: 0, snoozed: 0, done: 0 };
    for (const i of vault.later) out[i.state]++;
    return out;
  }, [vault.later]);
  const items = useMemo(() => {
    const list = vault.later.filter((i) => i.state === filter);
    if (filter === 'snoozed') return [...list].sort((a, b) => (a.snoozeUntil ?? 0) - (b.snoozeUntil ?? 0));
    if (filter === 'done') return [...list].sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
    return list;
  }, [vault.later, filter]);

  const addLink = async () => {
    const url = await dialogs.prompt({ title: 'Save a link to Later', label: 'Address', placeholder: 'https://…', confirm: 'Save' });
    if (!url) return;
    const normalized = /^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    if (!isRestorable(normalized)) {
      toast.error('That doesn’t look like an address TabVault can open.');
      return;
    }
    await toast.guard(rpc('later.addLink', { url: normalized, title: normalized }));
  };

  const addActive = async () => {
    const candidate = live.tabs.find((t) => t.windowId === live.currentWindowId && t.active && !t.url?.startsWith('chrome-extension://'));
    const others = live.tabs.filter((t) => !t.url?.startsWith('chrome-extension://') && t.windowId === live.currentWindowId && !t.pinned && !t.active);
    const target = candidate ?? others.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    if (!target?.id) {
      toast.info('No tab to save. Use “Add a link” instead.');
      return;
    }
    const r = await toast.guard(rpc('later.addTabs', { tabIds: [target.id], close: false }));
    if (r?.added) toast.ok(`Saved “${target.title}”`);
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1 className="page-title">Read it <em>later</em></h1>
            <div className="page-sub">For pages you want out of the way, not gone. Snooze one and it reopens by itself when you said.</div>
          </div>
          <span className="spacer" />
          <button className="btn" onClick={() => void addActive()}><ListPlus size={14} />Save a tab</button>
          <button className="btn" onClick={() => void addLink()}><Link2 size={14} />Add a link</button>
        </div>

        <Segmented<Filter> label="Queue state" value={filter} onChange={setFilter} options={[
          { value: 'queued', label: `Queue ${counts.queued || ''}` }, { value: 'snoozed', label: `Snoozed ${counts.snoozed || ''}` }, { value: 'done', label: `Done ${counts.done || ''}` },
        ]} />

        <div className="card list" style={{ marginTop: 12 }}>
          {!items.length && !loading && (
            <Empty
              icon={filter === 'snoozed' ? <BellOff size={20} /> : filter === 'done' ? <CheckCheck size={20} /> : <ListPlus size={20} />}
              title={filter === 'snoozed' ? 'Nothing snoozed' : filter === 'done' ? 'Nothing finished yet' : 'Your queue is empty'}
            >
              {filter === 'queued' && <>Press <Kbd>Alt</Kbd> <Kbd>Shift</Kbd> <Kbd>S</Kbd> on any page, or right-click a link and choose “Save link to Later”.</>}
              {filter === 'snoozed' && 'Snooze a tab from the palette (Ctrl K on a result) and it comes back on schedule.'}
              {filter === 'done' && 'Opened items land here for 30 days in case you need them again.'}
            </Empty>
          )}
          {items.map((item) => <LaterRow key={item.id} item={item} note={notes.get(urlKey(item.url))?.note} />)}
        </div>
      </div>
    </div>
  );
}

function LaterRow({ item, note }: { item: LaterItem; note?: string }) {
  const toast = useToast();
  const snooze = snoozeOptions();
  const sub =
    item.state === 'snoozed' && item.snoozeUntil ? `Returns ${timeUntil(item.snoozeUntil)} (${formatDateTime(item.snoozeUntil)})` :
    item.state === 'done' && item.doneAt ? `Finished ${timeAgo(item.doneAt)}` :
    `Saved ${timeAgo(item.addedAt)}`;
  return (
    <div className="lrow">
      <Favicon url={item.url} />
      <button className="lrow-body" style={{ textAlign: 'left' }} onClick={() => void toast.guard(rpc('later.open', { id: item.id, keep: item.state === 'done' }))}>
        <div className="lrow-title">{item.title}</div>
        <div className="lrow-sub">{note ? `${note} · ` : ''}{displayUrl(item.url)} · {sub}</div>
      </button>
      <span className="lrow-actions">
        {item.state !== 'done' ? (
          <IconButton label="Mark done" onClick={() => void toast.guard(rpc('later.setState', { id: item.id, state: 'done' }))}><Check size={14} /></IconButton>
        ) : (
          <IconButton label="Back to queue" onClick={() => void toast.guard(rpc('later.setState', { id: item.id, state: 'queued' }))}><RotateCcw size={14} /></IconButton>
        )}
        {item.state !== 'done' && (
          <Dropdown
            label="Snooze"
            align="right"
            trigger={(p) => <IconButton label="Snooze" {...p}><Clock size={14} /></IconButton>}
            items={[
              ...snooze.map((o) => ({ id: o.id, label: o.label, run: () => void toast.guard(rpc('later.snooze', { id: item.id, until: o.at })).then(() => toast.ok(`Snoozed: ${o.label.toLowerCase()}`)) })),
              ...(item.state === 'snoozed' ? [{ id: 'unsnooze', label: 'Back to queue now', run: () => void toast.guard(rpc('later.setState', { id: item.id, state: 'queued' })) }] : []),
            ]}
          />
        )}
        <Dropdown
          label="More"
          align="right"
          trigger={(p) => <IconButton label="More" {...p}><MoreHorizontal size={14} /></IconButton>}
          items={[
            { id: 'keep', label: 'Open, keep in queue', run: () => void toast.guard(rpc('later.open', { id: item.id, keep: true })) },
            { id: 'copy', label: 'Copy link', run: () => void navigator.clipboard.writeText(item.url).then(() => toast.ok('Link copied')) },
            { id: 'remove', label: 'Remove', icon: <Trash2 size={15} />, danger: true, run: () => void toast.guard(rpc('later.remove', { ids: [item.id] })) },
          ]}
        />
      </span>
    </div>
  );
}
