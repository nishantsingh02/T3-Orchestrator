import { Check, ChevronDown } from 'lucide-react';
import { Select as S } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const SelectRoot = S.Root;
export const SelectValue = S.Value;

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof S.Trigger>) {
  return (
    <S.Trigger
      data-slot="select-trigger"
      className={cn(
        'flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background/60 px-2.5 text-[13px] whitespace-nowrap shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground dark:bg-input/25 [&>span]:truncate',
        className,
      )}
      {...props}
    >
      {children}
      <S.Icon asChild>
        <ChevronDown className="size-3.5 shrink-0 opacity-60" />
      </S.Icon>
    </S.Trigger>
  );
}

export function SelectContent({ className, children, position = 'popper', ...props }: ComponentProps<typeof S.Content>) {
  return (
    <S.Portal>
      <S.Content
        data-slot="select-content"
        position={position}
        className={cn(
          'relative z-[60] max-h-[min(var(--radix-select-content-available-height),320px)] min-w-[8rem] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          position === 'popper' && 'w-full min-w-[var(--radix-select-trigger-width)] data-[side=bottom]:translate-y-1',
          className,
        )}
        {...props}
      >
        <S.Viewport className="p-1">{children}</S.Viewport>
      </S.Content>
    </S.Portal>
  );
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof S.Item>) {
  return (
    <S.Item
      data-slot="select-item"
      className={cn(
        'relative flex w-full cursor-default items-center rounded-sm py-1.5 pr-7 pl-2 text-[13px] outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent',
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <S.ItemIndicator>
          <Check className="size-3.5" />
        </S.ItemIndicator>
      </span>
      <S.ItemText>{children}</S.ItemText>
    </S.Item>
  );
}

export interface SelectOption<V extends string> {
  value: V;
  label: ReactNode;
}

/** Compact controlled select. Radix forbids '' as an item value, so use a sentinel for "none". */
export function Select<V extends string>({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  disabled,
  id,
  size = 'default',
  'aria-label': ariaLabel,
}: {
  value: V | undefined;
  onValueChange: (v: V) => void;
  options: ReadonlyArray<SelectOption<V>>;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  size?: 'default' | 'sm';
  'aria-label'?: string;
}) {
  return (
    <S.Root value={value} onValueChange={(v) => onValueChange(v as V)} disabled={disabled}>
      <SelectTrigger id={id} aria-label={ariaLabel} className={cn(size === 'sm' && 'h-7 px-2 text-xs', className)}>
        <S.Value placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </S.Root>
  );
}
