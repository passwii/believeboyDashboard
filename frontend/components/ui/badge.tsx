import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2.5 py-1 text-[0.6875rem] font-semibold tracking-[0.01em] transition-colors focus:outline-none focus:ring-2 focus:ring-ring/20 focus:ring-offset-0 dark:shadow-[inset_0_1px_0_hsl(220_30%_100%/0.08)]',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90',
        secondary:
          'border-secondary/10 bg-secondary/10 text-secondary hover:bg-secondary/16 dark:border-secondary/20 dark:bg-secondary/16 dark:text-[hsl(var(--chart-2))]',
        destructive:
          'border-destructive/12 bg-destructive/10 text-destructive hover:bg-destructive/16 dark:border-destructive/20 dark:bg-destructive/14',
        success:
          'border-success/12 bg-success/10 text-success hover:bg-success/16 dark:border-success/20 dark:bg-success/14',
        warning:
          'border-warning/12 bg-warning/10 text-warning hover:bg-warning/16 dark:border-warning/20 dark:bg-warning/14',
        info:
          'border-primary/12 bg-primary/10 text-primary hover:bg-primary/16 dark:border-primary/20 dark:bg-primary/14',
        outline:
          'border-border/70 bg-background/88 text-foreground dark:border-border/95 dark:bg-[hsl(var(--surface-soft)/0.92)]',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
