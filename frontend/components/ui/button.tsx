import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent text-sm font-semibold ring-offset-background transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-0 disabled:pointer-events-none disabled:translate-y-0 disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-[linear-gradient(135deg,hsl(var(--primary)),hsl(var(--primary)/0.88))] text-primary-foreground shadow-[0_14px_28px_-18px_hsl(var(--primary)/0.72)] hover:-translate-y-0.5 hover:brightness-[1.03] hover:shadow-[0_18px_34px_-18px_hsl(var(--primary)/0.72)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[0_14px_28px_-18px_hsl(var(--destructive)/0.55)] hover:-translate-y-0.5 hover:bg-destructive/94",
        outline:
          "border-border/70 bg-background/92 text-foreground shadow-[inset_0_1px_0_hsl(0_0%_100%/0.52)] hover:border-primary/18 hover:bg-accent/72 hover:text-accent-foreground dark:border-border/95 dark:bg-[hsl(var(--surface-soft)/0.96)] dark:text-foreground dark:shadow-[inset_0_1px_0_hsl(220_30%_100%/0.05)] dark:hover:bg-[hsl(var(--surface-strong))]",
        secondary:
          "border-secondary/10 bg-secondary/10 text-secondary shadow-none hover:bg-secondary/16 hover:text-secondary",
        ghost: "bg-transparent text-secondary/92 shadow-none hover:bg-accent/72 hover:text-foreground dark:text-foreground/82 dark:hover:bg-[hsl(var(--surface-strong))] dark:hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-5 py-2.5",
        sm: "h-9 px-3.5 text-[0.82rem]",
        lg: "h-12 rounded-lg px-8 text-[0.95rem]",
        icon: "h-10 w-10 rounded-md",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
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
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
