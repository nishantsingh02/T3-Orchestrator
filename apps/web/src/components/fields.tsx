// Small form building blocks shared by the settings page and the dialogs.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/** Label + optional hint on the left, control on the right (stacks on narrow widths). */
export function FieldRow({
  label,
  hint,
  children,
  htmlFor,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6', className)}>
      <div className="min-w-0">
        <Label htmlFor={htmlFor} className="text-[13px] text-foreground">
          {label}
        </Label>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0 sm:w-56">{children}</div>
    </div>
  );
}

/** Label above the control. */
export function Field({
  label,
  hint,
  children,
  htmlFor,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function SwitchRow({
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-6 py-2.5">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-[13px] text-foreground">
          {label}
        </Label>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} className="mt-0.5" />
    </div>
  );
}

/**
 * Text input that keeps a local draft and commits on blur / Enter (mode "blur"), or on every
 * change (mode "change"). External value changes sync in while the field isn't focused.
 */
export function CommitInput({
  value,
  onCommit,
  mode = 'blur',
  nullable = false,
  className,
  ...rest
}: {
  value: string | null;
  onCommit: (v: string | null) => void;
  mode?: 'blur' | 'change';
  /** Commit '' as null. */
  nullable?: boolean;
  className?: string;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  'aria-label'?: string;
  mono?: boolean;
}) {
  const { mono, ...inputProps } = rest;
  const [draft, setDraft] = useState(value ?? '');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value ?? '');
  }, [value]);

  const normalize = (v: string) => (nullable && v.trim() === '' ? null : v);
  const commit = () => {
    const next = normalize(draft);
    if (next !== (value ?? (nullable ? null : ''))) onCommit(next);
  };

  return (
    <Input
      {...inputProps}
      value={draft}
      className={cn(mono && 'font-mono text-xs', className)}
      onFocus={() => (focused.current = true)}
      onChange={(e) => {
        setDraft(e.target.value);
        if (mode === 'change') onCommit(normalize(e.target.value));
      }}
      onBlur={() => {
        focused.current = false;
        if (mode === 'blur') commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && mode === 'blur') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape' && mode === 'blur') {
          setDraft(value ?? '');
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** Integer input clamped to [min, max]; commits on blur / Enter, or on change. */
export function NumberInput({
  value,
  onCommit,
  min,
  max,
  mode = 'blur',
  className,
  id,
  disabled,
  suffix,
}: {
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  mode?: 'blur' | 'change';
  className?: string;
  id?: string;
  disabled?: boolean;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const parse = (s: string): number | null => {
    const n = Number.parseInt(s, 10);
    if (Number.isNaN(n)) return null;
    return Math.min(max, Math.max(min, n));
  };

  return (
    <div className={cn('relative', className)}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        disabled={disabled}
        value={draft}
        className={cn('tabular', suffix && 'pr-10')}
        onFocus={() => (focused.current = true)}
        onChange={(e) => {
          setDraft(e.target.value);
          if (mode === 'change') {
            const n = parse(e.target.value);
            if (n !== null) onCommit(n);
          }
        }}
        onBlur={() => {
          focused.current = false;
          const n = parse(draft);
          if (n === null) {
            setDraft(String(value));
            return;
          }
          setDraft(String(n));
          if (n !== value) onCommit(n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
      {suffix && (
        <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">
          {suffix}
        </span>
      )}
    </div>
  );
}

/** A titled group of rows with dividers. */
export function Section({
  title,
  description,
  children,
  actions,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="rounded-lg border border-border bg-card">
      <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-[13.5px] font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {actions}
      </header>
      <div className="divide-y divide-border px-4">{children}</div>
    </section>
  );
}
