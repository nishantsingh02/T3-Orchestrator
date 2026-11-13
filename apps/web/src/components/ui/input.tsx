import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const fieldClass =
  'w-full min-w-0 rounded-md border border-input bg-background/60 px-2.5 text-[13px] text-foreground shadow-xs transition-[border-color,box-shadow] outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/25';

export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return <input data-slot="input" type={type} className={cn(fieldClass, 'h-8', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(fieldClass, 'min-h-16 resize-y py-1.5 leading-relaxed scrollbar-thin', className)}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn('text-xs font-medium text-muted-foreground select-none', className)}
      {...props}
    />
  );
}

export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] leading-none text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
