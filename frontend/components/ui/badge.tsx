import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const badgeVariants = cva(
  // Terminal 收口（BLF-872）：零圆角 + mono 小字 + 零阴影（去除暗黑玻璃内高光）
  'inline-flex items-center rounded-none border px-2 py-0.5 font-mono text-[0.6875rem] font-semibold tracking-wide shadow-none transition-colors focus:outline-none focus:ring-2 focus:ring-ring/20 focus:ring-offset-0',
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
        outline: 'border-term-border bg-term-panel text-term-text',
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
