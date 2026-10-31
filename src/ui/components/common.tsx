import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent,
  type ButtonHTMLAttributes, type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  BookOpen, Briefcase, Code2, Compass, Film, FlaskConical, GraduationCap, Home, Layers, Music, Rocket, User, type LucideIcon,
} from 'lucide-react';
import type { TabColor, WorkspaceIcon } from '../../shared/types';
import { faviconUrl } from '../../shared/urls';

export const WORKSPACE_ICON_MAP: Record<WorkspaceIcon, LucideIcon> = {
  layers: Layers, code: Code2, book: BookOpen, graduation: GraduationCap, briefcase: Briefcase, flask: FlaskConical,
  film: Film, music: Music, user: User, home: Home, rocket: Rocket, compass: Compass,
};

export function colorVar(color: TabColor): string {
  return `var(--c-${color})`;
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <rect width="32" height="32" rx="9" fill="var(--logo-bg)" />
      <circle cx="16" cy="16" r="8" fill="none" stroke="var(--logo-fg)" strokeWidth="2" />
      <path d="M16 16l3.6-3.6" stroke="var(--logo-fg)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function Favicon({ url, size = 16 }: { url: string; size?: number }) {
  return <img className="favicon" src={faviconUrl(url, size * 2)} width={size} height={size} alt="" loading="lazy" draggable={false} />;
}

export function WorkspaceBadge({ color, icon, size = 28 }: { color: TabColor; icon: WorkspaceIcon; size?: number }) {
  const Icon = WORKSPACE_ICON_MAP[icon];
  return (
    <span className="ws-badge" style={{ '--ws': colorVar(color), width: size, height: size } as CSSProperties}>
      <Icon size={Math.round(size * 0.56)} />
    </span>
  );
}

const prefersStill = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Counts up to a number when it first appears, then eases between later values. */
export function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(() => (prefersStill() ? value : 0));
  const from = useRef(shown);
  useEffect(() => {
    const start = performance.now();
    const origin = from.current;
    let raf = requestAnimationFrame(function step(now) {
      const t = prefersStill() ? 1 : Math.min(1, (now - start) / 800);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = Math.round(origin + (value - origin) * eased);
      from.current = current;
      setShown(current);
      if (t < 1) raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{shown}</>;
}

export function Stat({ value, label, onClick }: { value: number | string; label: string; onClick?: () => void }) {
  const body = <><div className="stat-value">{typeof value === 'number' ? <CountUp value={value} /> : value}</div><div className="stat-label">{label}</div></>;
  return onClick ? <button className="card stat" style={{ textAlign: 'left' }} onClick={onClick}>{body}</button> : <div className="card stat">{body}</div>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function IconButton({
  label, children, active, className = '', ...rest
}: { label: string; active?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`icon-btn${active ? ' is-active' : ''} ${className}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)}>
      <span className="switch-thumb" />
    </button>
  );
}

export function Segmented<T extends string>({
  value, options, onChange, label,
}: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? 'is-on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---- menu ----

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

export function useDismiss(ref: RefObject<HTMLElement | null>, onDismiss: () => void, active = true): void {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [ref, onDismiss, active]);
}

/** Keyboard-navigable list of actions. Used by dropdowns and the palette's action panel. */
export function MenuList({ items, onClose, autoFocus = true, label }: { items: MenuItem[]; onClose: () => void; autoFocus?: boolean; label: string }) {
  const enabled = useMemo(() => items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0), [items]);
  const [cursor, setCursor] = useState(enabled[0] ?? 0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const at = enabled.indexOf(cursor);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setCursor(enabled[(at + 1) % enabled.length] ?? cursor);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setCursor(enabled[(at - 1 + enabled.length) % enabled.length] ?? cursor);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const item = items[cursor];
      if (item && !item.disabled) {
        onClose();
        item.run();
      }
    } else if (e.key === 'Escape' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div ref={ref} className="menu" role="menu" tabIndex={-1} aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={item.disabled}
          className={`menu-item${i === cursor ? ' is-cursor' : ''}${item.danger ? ' is-danger' : ''}`}
          onMouseEnter={() => !item.disabled && setCursor(i)}
          onClick={() => {
            onClose();
            item.run();
          }}
        >
          {item.icon && <span className="menu-icon">{item.icon}</span>}
          <span className="menu-label">{item.label}</span>
          {item.hint && <span className="menu-hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}

export function Dropdown({
  trigger, items, label, align = 'left',
}: { trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode; items: MenuItem[]; label: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, close, open);
  return (
    <div className="dropdown" ref={ref}>
      {trigger({ onClick: () => setOpen((v) => !v), 'aria-expanded': open, 'aria-haspopup': 'menu' })}
      {open && (
        <div className={`dropdown-pop dropdown-${align}`}>
          <MenuList items={items} onClose={close} label={label} />
        </div>
      )}
    </div>
  );
}

/** Actions at the mouse, for right-clicking a row. The backdrop takes the next click so it can't also hit the row. */
export function ContextMenu({ at, items, label, onClose }: { at: { x: number; y: number }; items: MenuItem[]; label: string; onClose: () => void }) {
  const openUp = at.y > window.innerHeight / 2;
  const style = {
    left: Math.max(8, Math.min(at.x, window.innerWidth - 248)),
    ...(openUp ? { bottom: window.innerHeight - at.y } : { top: at.y }),
    '--room': `${(openUp ? at.y : window.innerHeight - at.y) - 8}px`,
  } as unknown as CSSProperties;
  return createPortal(
    <>
      <div className="context-backdrop" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="context-menu" style={style} onContextMenu={(e) => e.preventDefault()}>
        <MenuList items={items} onClose={onClose} label={label} />
      </div>
    </>,
    document.body,
  );
}

// ---- virtual list ----

export interface VirtualListHandle {
  scrollToIndex: (index: number) => void;
}

/**
 * Minimal windowed list with per-row known heights. Thousands of tabs render about
 * twenty DOM rows. Nothing fancier is needed because row heights are fixed per type.
 */
export function VirtualList<T>({
  items, heightOf, render, keyOf, handleRef, className = '', overscan = 6, ariaLabel, role = 'list',
}: {
  items: T[];
  heightOf: (item: T) => number;
  render: (item: T, index: number) => ReactNode;
  keyOf: (item: T) => string | number;
  handleRef?: RefObject<VirtualListHandle | null>;
  className?: string;
  overscan?: number;
  ariaLabel?: string;
  role?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);

  const offsets = useMemo(() => {
    const out = new Array<number>(items.length + 1);
    out[0] = 0;
    for (let i = 0; i < items.length; i++) out[i + 1] = out[i]! + heightOf(items[i]!);
    return out;
  }, [items, heightOf]);
  const total = offsets[items.length] ?? 0;

  useLayoutEffect(() => {
    const el = container.current!;
    setViewport(el.clientHeight);
    const observer = new ResizeObserver(() => setViewport(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Clamp after the list shrinks, otherwise we'd render an empty window.
  useEffect(() => {
    const el = container.current!;
    if (el.scrollTop > Math.max(0, total - el.clientHeight)) el.scrollTop = Math.max(0, total - el.clientHeight);
  }, [total]);

  if (handleRef) {
    handleRef.current = {
      scrollToIndex: (index) => {
        const el = container.current;
        if (!el) return;
        const top = offsets[index] ?? 0;
        const bottom = offsets[index + 1] ?? top;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
      },
    };
  }

  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((offsets[mid + 1] ?? 0) <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  const start = Math.max(0, lo - overscan);
  let end = lo;
  while (end < items.length && (offsets[end] ?? 0) < scrollTop + viewport) end++;
  end = Math.min(items.length, end + overscan);

  const visible = [];
  for (let i = start; i < end; i++) {
    const item = items[i]!;
    visible.push(
      <div key={keyOf(item)} className="vrow" style={{ top: offsets[i], height: heightOf(item) }}>
        {render(item, i)}
      </div>,
    );
  }

  return (
    <div
      ref={container}
      className={`vlist ${className}`}
      role={role}
      aria-label={ariaLabel}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: total, position: 'relative' }}>{visible}</div>
    </div>
  );
}
