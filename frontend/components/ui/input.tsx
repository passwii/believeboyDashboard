import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const inputVariants = cva(
  'flex w-full rounded-none border border-term-border bg-term-bg px-3 py-2 font-mono text-sm leading-5 text-term-text shadow-none ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-term-faint focus-visible:outline-none focus-visible:border-term-border-strong focus-visible:ring-0 focus-visible:ring-offset-0 u-focus-glow disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-term-neg aria-[invalid=true]:focus-visible:border-term-neg',
  {
    variants: {
      size: {
        default: 'h-8',
        sm: 'h-7 text-xs leading-4',
        lg: 'h-9',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  }
)

export interface InputProps
  extends Omit<React.ComponentProps<'input'>, 'size'>,
    VariantProps<typeof inputVariants> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, size, type, ...props }, ref) => {
    return (
      <input type={type} className={cn(inputVariants({ size, className }))} ref={ref} {...props} />
    )
  }
)
Input.displayName = 'Input'

export { Input, inputVariants }
