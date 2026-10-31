import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Info, X } from 'lucide-react';

// ---- toasts ----

interface ToastAction {
  label: string;
  run: () => void | Promise<unknown>;
}
interface ToastItem {
  id: number;
  message: string;
  tone: 'ok' | 'error' | 'info';
  action?: ToastAction;
}
export interface ToastApi {
  ok: (message: string, action?: ToastAction) => void;
  info: (message: string, action?: ToastAction) => void;
  error: (message: string) => void;
  /** Run an async action; report failure as a toast rather than losing it. */
  guard: <T>(work: Promise<T>) => Promise<T | undefined>;
}

const ToastContext = createContext<ToastApi | null>(null);
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (tone: ToastItem['tone'], message: string, action?: ToastAction) => {
      const id = nextId++;
      setItems((list) => [...list.slice(-3), { id, tone, message, action }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 8000 : action ? 7000 : 3500);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(() => {
    const error = (message: string) => push('error', message);
    return {
      ok: (m, a) => push('ok', m, a),
      info: (m, a) => push('info', m, a),
      error,
      guard: async (work) => {
        try {
          return await work;
        } catch (err) {
          error((err as Error).message || 'Something went wrong.');
          return undefined;
        }
      },
    };
  }, [push]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.tone === 'ok' ? <Check size={15} /> : t.tone === 'error' ? <AlertTriangle size={15} /> : <Info size={15} />}
            <span className="toast-msg">{t.message}</span>
            {t.action && (
              <button
                className="toast-action"
                onClick={() => {
                  dismiss(t.id);
                  void Promise.resolve(t.action!.run()).catch((err: Error) => api.error(err.message));
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}

// ---- dialogs ----

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<Element | null>(null);
  useEffect(() => {
    returnFocus.current = document.activeElement;
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const previous = returnFocus.current;
    return () => {
      (previous as HTMLElement | null)?.focus?.();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' dialog-wide' : ''}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-body">
        <h2 className="dialog-title">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirm?: string;
  danger?: boolean;
}
interface PromptOptions {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirm?: string;
  multiline?: boolean;
  allowEmpty?: boolean;
}
export interface Dialogs {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
}

const DialogContext = createContext<Dialogs | null>(null);

type Pending =
  | { type: 'confirm'; options: ConfirmOptions; resolve: (v: boolean) => void }
  | { type: 'prompt'; options: PromptOptions; resolve: (v: string | null) => void };

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const api = useMemo<Dialogs>(
    () => ({
      confirm: (options) => new Promise((resolve) => setPending({ type: 'confirm', options, resolve })),
      prompt: (options) => new Promise((resolve) => setPending({ type: 'prompt', options, resolve })),
    }),
    [],
  );
  return (
    <DialogContext.Provider value={api}>
      {children}
      {pending?.type === 'confirm' && (
        <ConfirmDialog
          options={pending.options}
          done={(v) => {
            pending.resolve(v);
            setPending(null);
          }}
        />
      )}
      {pending?.type === 'prompt' && (
        <PromptDialog
          options={pending.options}
          done={(v) => {
            pending.resolve(v);
            setPending(null);
          }}
        />
      )}
    </DialogContext.Provider>
  );
}

export function useDialogs(): Dialogs {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialogs outside DialogProvider');
  return ctx;
}

function ConfirmDialog({ options, done }: { options: ConfirmOptions; done: (v: boolean) => void }) {
  return (
    <Dialog title={options.title} onClose={() => done(false)}>
      {options.body && <div className="dialog-text">{options.body}</div>}
      <div className="dialog-actions">
        <button className="btn" onClick={() => done(false)}>Cancel</button>
        <button className={`btn ${options.danger ? 'btn-danger' : 'btn-primary'}`} data-autofocus onClick={() => done(true)}>
          {options.confirm ?? 'Confirm'}
        </button>
      </div>
    </Dialog>
  );
}

function PromptDialog({ options, done }: { options: PromptOptions; done: (v: string | null) => void }) {
  const [value, setValue] = useState(options.initial ?? '');
  const canSubmit = options.allowEmpty || value.trim().length > 0;
  const submit = () => {
    if (canSubmit) done(value);
  };
  return (
    <Dialog title={options.title} onClose={() => done(null)}>
      {options.label && <label className="field-label" htmlFor="prompt-input">{options.label}</label>}
      {options.multiline ? (
        <textarea
          id="prompt-input"
          className="input textarea"
          rows={4}
          data-autofocus
          value={value}
          placeholder={options.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
          }}
        />
      ) : (
        <input
          id="prompt-input"
          className="input"
          data-autofocus
          value={value}
          placeholder={options.placeholder}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
      )}
      <div className="dialog-actions">
        <button className="btn" onClick={() => done(null)}>Cancel</button>
        <button className="btn btn-primary" disabled={!canSubmit} onClick={submit}>{options.confirm ?? 'Save'}</button>
      </div>
    </Dialog>
  );
}
