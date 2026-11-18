import { Check, Plus, Search, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface DepOption {
  value: string;
  /** Short label, e.g. "#4" or "T3". */
  label: string;
  title: string;
  /** Extra text on the right of the option row (e.g. the stage). */
  meta?: ReactNode;
  disabled?: boolean;
  /** Reason shown when disabled (e.g. "would create a cycle"). */
  disabledReason?: string;
}

interface Props {
  options: DepOption[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Values rendered red (e.g. blocked dependencies). */
  danger?: ReadonlySet<string>;
  placeholder?: string;
  size?: 'default' | 'sm';
  emptyText?: string;
}

/** Chips for the selected dependencies plus a searchable popover to add/remove them. */
export function DepsPicker({
  options,
  value,
  onChange,
  disabled,
  danger,
  placeholder = 'Add dependency',
  size = 'default',
  emptyText = 'No other tasks',
}: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const selected = new Set(value);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase().replace(/^#/, '');
    if (!needle) return options;
    return options.filter(
      (o) => o.label.toLowerCase().replace(/^#/, '').includes(needle) || o.title.toLowerCase().includes(needle),
    );
  }, [options, q]);

  const toggle = (v: string) => onChange(selected.has(v) ? value.filter((x) => x !== v) : [...value, v]);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((v) => {
        const o = byValue.get(v);
        return (
          <span
            key={v}
            title={o?.title}
            className={cn(
              'inline-flex items-center gap-1 rounded border border-border bg-muted pr-0.5 pl-1.5 font-mono text-[11px]',
              size === 'sm' ? 'h-5' : 'h-6',
              danger?.has(v) && 'border-destructive/45 bg-destructive/12 text-destructive',
              !o && 'border-destructive/45 text-destructive',
            )}
          >
            {o?.label ?? v}
            {!disabled && (
              <button
                type="button"
                onClick={() => toggle(v)}
                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={`Remove ${o?.label ?? v}`}
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        );
      })}
      {!disabled && (
        <Popover
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) setQ('');
          }}
        >
          <PopoverTrigger asChild>
            <Button variant="ghost" size={size === 'sm' ? 'xs' : 'sm'} className="text-muted-foreground">
              <Plus />
              {value.length === 0 ? placeholder : ''}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
            <div className="flex items-center gap-2 border-b border-border px-2.5">
              <Search className="size-3.5 text-muted-foreground" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search tasks…"
                className="h-9 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="max-h-64 overflow-y-auto p-1 scrollbar-thin">
              {filtered.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted-foreground">{emptyText}</p>}
              {filtered.map((o) => {
                const isOn = selected.has(o.value);
                const blocked = o.disabled && !isOn;
                return (
                  <button
                    key={o.value}
                    type="button"
                    disabled={blocked}
                    title={blocked ? o.disabledReason : o.title}
                    onClick={() => toggle(o.value)}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <span
                      className={cn(
                        'grid size-3.5 shrink-0 place-content-center rounded-[3px] border border-border-strong',
                        isOn && 'border-primary bg-primary text-primary-foreground',
                      )}
                    >
                      {isOn && <Check className="size-2.5" />}
                    </span>
                    <span className="w-9 shrink-0 font-mono text-[11px] text-muted-foreground">{o.label}</span>
                    <span className="min-w-0 flex-1 truncate">{o.title}</span>
                    {blocked && o.disabledReason ? (
                      <span className="shrink-0 text-[10.5px] text-muted-foreground">{o.disabledReason}</span>
                    ) : (
                      o.meta && <span className="shrink-0 text-[10.5px] text-muted-foreground">{o.meta}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
