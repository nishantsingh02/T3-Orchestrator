import { X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;
export const DialogPortal = D.Portal;

export function DialogOverlay({ className, ...props }: ComponentProps<typeof D.Overlay>) {
  return (
    <D.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/55 backdrop-blur-[1px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        className,
      )}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  showClose = true,
  ...props
}: ComponentProps<typeof D.Content> & { showClose?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <D.Content
        data-slot="dialog-content"
        className={cn(
          'fixed top-[50%] left-[50%] z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-2xl outline-none scrollbar-thin data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98]',
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <D.Close className="absolute top-3.5 right-3.5 rounded-sm p-0.5 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </D.Close>
        )}
      </D.Content>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 pr-6', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof D.Title>) {
  return <D.Title className={cn('text-[15px] font-semibold leading-tight', className)} {...props} />;
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof D.Description>) {
  return <D.Description className={cn('text-[13px] text-muted-foreground', className)} {...props} />;
}

/** Right-side sheet (the task drawer). Full screen below md. */
export function SheetContent({ className, children, ...props }: ComponentProps<typeof D.Content>) {
  return (
    <DialogPortal>
      <DialogOverlay className="bg-black/35 backdrop-blur-none" />
      <D.Content
        data-slot="sheet-content"
        className={cn(
          'fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col border-l border-border bg-background shadow-2xl outline-none md:w-1/2 md:min-w-[560px] data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=open]:duration-200 data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=closed]:duration-150',
          className,
        )}
        {...props}
      >
        {children}
      </D.Content>
    </DialogPortal>
  );
}
