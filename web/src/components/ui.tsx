import type { ReactNode } from 'react';

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

const statusStyles: Record<string, string> = {
  created: 'bg-slate-700/40 text-slate-300 ring-slate-600',
  provisioning: 'bg-amber-500/15 text-amber-300 ring-amber-500/40',
  ready: 'bg-sky-500/15 text-sky-300 ring-sky-500/40',
  calling: 'bg-sky-500/15 text-sky-300 ring-sky-500/40 animate-pulse',
  in_progress: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40 animate-pulse',
  completed: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40',
  failed: 'bg-rose-500/15 text-rose-300 ring-rose-500/40',
  expired: 'bg-amber-500/15 text-amber-300 ring-amber-500/40',
  pass: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40',
  borderline: 'bg-amber-500/15 text-amber-300 ring-amber-500/40',
  fail: 'bg-rose-500/15 text-rose-300 ring-rose-500/40',
  sent: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40',
  skipped: 'bg-slate-700/40 text-slate-300 ring-slate-600',
  pending: 'bg-slate-700/40 text-slate-300 ring-slate-600',
};

export function Badge({ value, label }: { value: string; label?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ring-1 ring-inset',
        statusStyles[value] ?? 'bg-slate-700/40 text-slate-300 ring-slate-600',
      )}
    >
      {(label ?? value).replace(/_/g, ' ')}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
  type = 'button',
  title,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  className?: string;
}) {
  const styles = {
    primary: 'bg-brand-600 hover:bg-brand-500 text-white shadow-sm',
    secondary: 'bg-slate-800 hover:bg-slate-700 text-slate-100 ring-1 ring-inset ring-slate-700',
    ghost: 'bg-transparent hover:bg-slate-800 text-slate-300',
    danger: 'bg-rose-600/90 hover:bg-rose-500 text-white',
  }[variant];

  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition',
        'disabled:cursor-not-allowed disabled:opacity-50',
        styles,
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg', className)}>
      {children}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg bg-slate-800/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-0.5 text-sm text-slate-200">{value}</div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        'inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-500 border-t-transparent',
        className,
      )}
    />
  );
}

export function ProgressBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  const color = clamped >= 70 ? 'bg-emerald-500' : clamped >= 50 ? 'bg-amber-500' : 'bg-rose-500';
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
      <div className={cx('h-full rounded-full transition-all', color)} style={{ width: `${clamped}%` }} />
    </div>
  );
}
