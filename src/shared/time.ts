export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function timeAgo(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function timeUntil(ts: number, now = Date.now()): string {
  const diff = ts - now;
  if (diff <= 0) return 'now';
  if (diff < HOUR) return `in ${Math.max(1, Math.round(diff / MINUTE))}m`;
  if (diff < DAY) return `in ${Math.round(diff / HOUR)}h`;
  return `in ${Math.round(diff / DAY)}d`;
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export interface SnoozeOption {
  id: string;
  label: string;
  at: number;
}

/** Snooze presets, computed from "now" so labels stay honest late at night. */
export function snoozeOptions(now = Date.now()): SnoozeOption[] {
  const d = new Date(now);
  const at = (days: number, hour: number) => {
    const x = new Date(d);
    x.setDate(x.getDate() + days);
    x.setHours(hour, 0, 0, 0);
    return x.getTime();
  };
  const options: SnoozeOption[] = [{ id: '1h', label: 'In an hour', at: now + HOUR }];
  if (d.getHours() < 17) options.push({ id: 'evening', label: 'This evening', at: at(0, 18) });
  options.push({ id: 'tomorrow', label: 'Tomorrow morning', at: at(1, 9) });
  const dow = d.getDay();
  const toSaturday = (6 - dow + 7) % 7 || 7;
  const toMonday = (1 - dow + 7) % 7 || 7;
  options.push({ id: 'weekend', label: 'This weekend', at: at(toSaturday, 10) });
  options.push({ id: 'nextweek', label: 'Next week', at: at(toMonday, 9) });
  return options;
}
