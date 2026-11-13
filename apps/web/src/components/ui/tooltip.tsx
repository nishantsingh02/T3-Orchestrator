import { Tooltip as T } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const TooltipProvider = T.Provider;
export const TooltipRoot = T.Root;
export const TooltipTrigger = T.Trigger;

export function TooltipContent({ className, sideOffset = 6, children, ...props }: ComponentProps<typeof T.Content>) {
  return (
    <T.Portal>
      <T.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'z-[60] max-w-xs rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
          className,
        )}
        {...props}
      >
        {children}
      </T.Content>
    </T.Portal>
  );
}

/** Shorthand: wraps a single focusable child with a tooltip. */
export function Tip({
  content,
  children,
  side,
  disabled,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  disabled?: boolean;
}) {
  if (disabled || !content) return <>{children}</>;
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </T.Root>
  );
}
