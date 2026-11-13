import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-[5px] border font-medium leading-none [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-border bg-muted text-muted-foreground',
        outline: 'border-border text-muted-foreground',
        primary: 'border-primary/30 bg-primary/12 text-primary',
        success: 'border-success/30 bg-success/12 text-success',
        warning: 'border-warning/35 bg-warning/12 text-warning',
        destructive: 'border-destructive/35 bg-destructive/12 text-destructive',
        info: 'border-info/30 bg-info/12 text-info',
      },
      size: {
        default: 'h-5 px-1.5 text-2xs',
        sm: 'h-4 px-1 text-[10px]',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}
