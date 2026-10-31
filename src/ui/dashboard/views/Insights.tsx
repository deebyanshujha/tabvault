import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { BarChart3 } from 'lucide-react';
import type { DayActivity } from '../../../shared/types';
import { dayKey, DAY, formatDuration } from '../../../shared/time';
import { emptyDay, formatHour, summarize, type InsightSummary, type Slice } from '../../../shared/insights';
import { Empty, Segmented, Stat } from '../../components/common';
import { plural } from '../../lib/actions';
import { usePrefs, useVault, type LiveData } from '../../lib/hooks';
import { rpc } from '../../lib/rpc';

type Range = '7' | '30';

export function InsightsView({ live }: { live: LiveData }) {
  const { lastTopics } = useVault();
  const [prefs, updatePrefs] = usePrefs();
  const [days, setDays] = useState<DayActivity[]>([]);
  const [range, setRange] = useState<Range>('7');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    rpc('insights.read', {}).then(setDays, () => undefined).finally(() => setLoaded(true));
  }, [lastTopics, live.tabs.length]);

  const span = Number(range);
  const summary = useMemo(() => summarize(days, span), [days, span]);
  const series = useMemo(() => {
    const byDay = new Map(days.map((d) => [d.day, d]));
    const out: DayActivity[] = [];
    for (let i = span - 1; i >= 0; i--) {
      const day = dayKey(Date.now() - i * DAY);
      out.push(byDay.get(day) ?? emptyDay(day));
    }
    return out;
  }, [days, span]);

  const hasData = summary.opened || summary.closed || summary.seconds;
  const net = summary.opened - summary.closed;

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1 className="page-title">Your <em>insights</em></h1>
            <div className="page-sub">Counted on this device, per site, never per page. Kept for 90 days.</div>
          </div>
          <span className="spacer" />
          <Segmented<Range> label="Time range" value={range} onChange={setRange} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }]} />
        </div>

        {!prefs.activity && (
          <div className="banner" style={{ margin: '0 0 24px' }}>
            <BarChart3 size={15} />
            <span className="spacer">Activity tracking is off, so nothing new is being counted.</span>
            <button className="btn btn-sm btn-primary" onClick={() => updatePrefs({ activity: true })}>Turn on</button>
          </div>
        )}

        {!hasData && loaded ? (
          <div className="card"><Empty icon={<BarChart3 size={20} />} title="Nothing to show yet">Browse for a bit. Where your attention goes shows up here, and only here.</Empty></div>
        ) : (
          <>
            <div className="stat-line">
              <Stat value={formatDuration(summary.seconds)} label="focused on web pages" />
              <Stat value={summary.opened} label="tabs opened" />
              <Stat value={summary.closed} label="tabs closed" />
              <Stat value={net > 0 ? `+${net}` : net} label={net > 0 ? 'more opened than closed' : net < 0 ? 'more closed than opened' : 'opened and closed evenly'} />
              <Stat value={summary.peak} label="most open at once" />
            </div>

            <Facts summary={summary} span={span} />

            <h2 className="section-title">Where your time <em>went</em></h2>
            <div className="card share">
              {summary.slices.length ? <ShareChart summary={summary} /> : <div className="muted">No focus time recorded yet. Time counts while a site’s tab is focused and you’re active.</div>}
            </div>

            <h2 className="section-title">When you <em>browse</em></h2>
            <div className="card chart-card"><HourGrid summary={summary} /></div>

            <h2 className="section-title">Day by <em>day</em></h2>
            <div className="two-col">
              <DayChart title="Focus time" series={series} value={(d) => Object.values(d.focusSeconds).reduce((a, s) => a + s, 0)} format={formatDuration} />
              <DayChart title="Tabs opened" series={series} value={(d) => d.opened} format={(n) => plural(n, 'tab')} />
              <DayChart title="Peak open tabs" series={series} value={(d) => d.peakTabs} format={(n) => `${n} open`} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Facts({ summary, span }: { summary: InsightSummary; span: number }) {
  const { peakHour, switchEvery, longest, change, busiestDay, newSites, streak, sites, topThreeShare } = summary;
  const weekday = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' });
  const facts: { label: string; value: string; sub: string }[] = [];
  if (peakHour) facts.push({ label: 'You’re most active around', value: formatHour(peakHour.hour), sub: `${formatDuration(peakHour.seconds)} in that hour` });
  if (longest) facts.push({ label: 'Longest unbroken stretch', value: formatDuration(longest.seconds), sub: `on ${longest.domain}` });
  if (switchEvery !== null) facts.push({ label: 'You change site every', value: formatDuration(switchEvery), sub: plural(summary.switches, 'site change') });
  if (change !== null) facts.push({ label: `Compared with the ${span} days before`, value: `${change > 0 ? '+' : ''}${change}%`, sub: `${formatDuration(summary.seconds)} against ${formatDuration(summary.previousSeconds)}` });
  if (sites.length > 3) facts.push({ label: 'Your top three sites hold', value: `${Math.round(topThreeShare * 100)}%`, sub: sites.slice(0, 3).map((s) => s.domain).join(', ') });
  if (busiestDay) facts.push({ label: 'Busiest day', value: weekday(busiestDay.day), sub: `${formatDuration(busiestDay.seconds)} focused` });
  if (newSites) facts.push({ label: 'New sites this period', value: String(newSites.length), sub: newSites.slice(0, 3).join(', ') || 'Only familiar places' });
  if (streak > 1) facts.push({ label: 'Days in a row', value: String(streak), sub: 'with time on the web' });
  if (!facts.length) return null;
  return (
    <div className="facts">
      {facts.map((f) => (
        <div className="fact" key={f.label}>
          <div className="fact-label">{f.label}</div>
          <div className="fact-value">{f.value}</div>
          <div className="fact-sub" title={f.sub}>{f.sub}</div>
        </div>
      ))}
    </div>
  );
}

const sliceColor = (s: Slice) => (s.slot === undefined ? 'var(--s-other)' : `var(--s${s.slot})`);

function ShareChart({ summary }: { summary: InsightSummary }) {
  const { slices, seconds, sites } = summary;
  const [active, setActive] = useState<string | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const focused = slices.find((s) => s.label === active);
  const gap = slices.length > 1 ? 0.6 : 0;
  let start = 0;
  const arcs = slices.map((s) => {
    const arc = { slice: s, start, length: Math.max(0.2, s.share * 100 - gap) };
    start += s.share * 100;
    return arc;
  });
  const summaryLabel = slices.map((s) => `${s.label} ${Math.round(s.share * 100)}%`).join(', ');

  return (
    <>
      <div className={`donut${focused ? ' has-focus' : ''}`} role="img" aria-label={`Share of focus time: ${summaryLabel}`}>
        <svg viewBox="0 0 120 120" aria-hidden="true">
          {arcs.map(({ slice, start: from, length }, i) => (
            <circle
              key={slice.label}
              className={slice.label === active ? 'is-on' : ''}
              cx="60" cy="60" r="48" pathLength="100"
              stroke={sliceColor(slice)}
              strokeDasharray={drawn ? `${length} ${100 - length}` : `0 100`}
              strokeDashoffset={-from}
              style={{ transitionDelay: drawn && !active ? `${i * 70}ms, 0ms, 0ms` : '0ms' }}
            />
          ))}
        </svg>
        <div className="donut-center">
          <div className="donut-value">{focused ? `${Math.round(focused.share * 100)}%` : formatDuration(seconds)}</div>
          <div className="donut-label">{focused ? focused.label : 'in total'}</div>
        </div>
      </div>

      <div className={`legend${focused ? ' has-focus' : ''}`}>
        {slices.map((s) => (
          <button
            key={s.label}
            type="button"
            className={`legend-row${s.label === active ? ' is-on' : ''}`}
            style={{ '--slice': sliceColor(s) } as CSSProperties}
            onMouseEnter={() => setActive(s.label)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(s.label)}
            onBlur={() => setActive(null)}
            onClick={() => s.count !== undefined && setShowAll((v) => !v)}
          >
            <span className="legend-swatch" />
            <span className="legend-name">{s.count !== undefined ? `${plural(s.count, 'other site')}` : s.label}</span>
            <span className="legend-share">{Math.round(s.share * 100)}%</span>
            <span className="legend-time">{formatDuration(s.seconds)}</span>
          </button>
        ))}
        {showAll && (
          <div className="all-sites">
            {sites.slice(5).map((s) => (
              <div className="hbar" key={s.domain} title={`${s.domain}: ${formatDuration(s.seconds)}`}>
                <span className="hbar-label">{s.domain}</span>
                <div className="hbar-track"><div className="hbar-fill" style={{ width: `${(s.seconds / sites[5]!.seconds) * 100}%` }} /></div>
                <span className="hbar-value">{formatDuration(s.seconds)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Lifts small values so a quiet hour is still visibly different from an empty one. */
const heatLevel = (s: number, max: number) => (s > 0 ? `${Math.round(14 + 86 * Math.pow(s / max, 0.7))}%` : '0%');

function HourGrid({ summary }: { summary: InsightSummary }) {
  const { grid, gridMax, peakHour } = summary;
  if (!gridMax) return <div className="muted">Your weekly rhythm starts filling in from here, one focused hour at a time.</div>;
  return (
    <>
      <div className="chart-title">Focus by hour</div>
      <div className="chart-sub">{peakHour ? `Your peak is around ${formatHour(peakHour.hour)}` : ''}</div>
      <div className="heat" role="img" aria-label={`Focus time by weekday and hour. ${peakHour ? `Peak around ${formatHour(peakHour.hour)}.` : ''}`}>
        {grid.map((row, d) => (
          <div key={WEEKDAYS[d]} style={{ display: 'contents' }}>
            <span className="heat-day">{WEEKDAYS[d]}</span>
            {row.map((s, h) => (
              <span
                key={h}
                className={`heat-cell${h >= 21 ? ' tip-left' : h <= 2 ? ' tip-right' : ''}`}
                style={{ '--v': heatLevel(s, gridMax), '--h': h } as CSSProperties}
                data-tip={`${WEEKDAYS[d]} ${formatHour(h)}: ${s ? formatDuration(s) : 'nothing'}`}
              />
            ))}
          </div>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, h) => <span className="heat-hour" key={h}>{h % 6 === 0 ? formatHour(h) : ''}</span>)}
      </div>
      <div className="heat-scale" aria-hidden="true">
        <span>Less</span>
        {['14%', '35%', '57%', '78%', '100%'].map((v) => <i key={v} style={{ '--v': v } as CSSProperties} />)}
        <span>More</span>
      </div>
    </>
  );
}

function DayChart({ title, series, value, format }: { title: string; series: DayActivity[]; value: (d: DayActivity) => number; format: (n: number) => string }) {
  const max = Math.max(1, ...series.map(value));
  const label = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return (
    <div className="card chart-card">
      <div className="chart-title">{title}</div>
      <div className="chart-sub">Highest: {format(Math.max(...series.map(value)))}</div>
      <div className="vbars" role="img" aria-label={`${title}: ${series.map((d) => `${label(d.day)} ${format(value(d))}`).join(', ')}`}>
        {series.map((d, i) => (
          <div className="vbar" key={d.day}>
            <div className="vbar-fill" style={{ height: `${(value(d) / max) * 100}%`, '--i': i } as CSSProperties} />
            <span className="vbar-tip">{label(d.day)}: {format(value(d))}</span>
          </div>
        ))}
      </div>
      <div className="vbar-axis"><span>{label(series[0]!.day)}</span><span>Today</span></div>
    </div>
  );
}
