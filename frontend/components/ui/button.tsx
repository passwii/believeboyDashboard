import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-none font-mono text-xs leading-5 ring-offset-background u-press u-focus u-interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // Terminal 收口（BLF-868）：零圆角 + 1px 边界 + mono 小字；u-btn 保留暗黑 Level-3 按压
        default:
          'u-btn border border-primary bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'u-btn border border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline:
          'u-btn border border-term-border bg-term-panel text-term-text hover:border-term-border-strong hover:bg-term-hover hover:text-term-text',
        secondary:
          'u-btn border border-term-border bg-term-raised text-term-text hover:bg-term-hover hover:text-term-text',
        ghost:
          'border border-transparent bg-transparent text-term-muted hover:bg-term-hover hover:text-term-text',
        link: 'border-transparent bg-transparent text-primary underline-offset-4 hover:underline',
        // 显式终端变体，供工具行等高密度场景直接取用（等价 outline 的 term 语义）
        term: 'u-btn border border-term-border bg-term-panel text-term-muted hover:border-term-border-strong hover:text-term-text active:bg-term-raised',
      },
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 px-2 text-[11px] leading-4',
        lg: 'h-9 px-4',
        icon: 'h-8 w-8 p-0',
        xs: 'h-7 px-1.5 text-[11px] leading-4',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
