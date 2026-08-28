import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const textareaVariants = cva(
  'flex min-h-[80px] w-full rounded-none border border-term-border bg-term-bg px-3 py-2 font-mono text-sm leading-5 text-term-text shadow-none ring-offset-background placeholder:text-term-faint focus-visible:outline-none focus-visible:border-term-border-strong focus-visible:ring-0 focus-visible:ring-offset-0 u-focus-glow disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-term-neg aria-[invalid=true]:focus-visible:border-term-neg',
  {
    variants: {
      size: {
        default: 'min-h-[80px]',
        sm: 'min-h-[60px] text-xs leading-4',
        lg: 'min-h-[120px]',
      },
    },
    defaultVariants: {
      size: 'default',
    },
  }
)

export interface TextareaProps
  extends React.ComponentProps<'textarea'>,
    VariantProps<typeof textareaVariants> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, size, ...props }, ref) => {
    return <textarea className={cn(textareaVariants({ size, className }))} ref={ref} {...props} />
  }
)
Textarea.displayName = 'Textarea'

export { Textarea, textareaVariants }
