import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-semibold ring-offset-background transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:translate-y-0 disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-[0_16px_28px_-18px_hsl(var(--primary)/0.7)] hover:-translate-y-0.5 hover:bg-[hsl(var(--primary)/0.94)] hover:shadow-[0_18px_34px_-18px_hsl(var(--primary)/0.7)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[0_16px_28px_-18px_hsl(var(--destructive)/0.55)] hover:-translate-y-0.5 hover:bg-destructive/92",
        outline:
          "border border-input bg-background/88 text-foreground shadow-[inset_0_1px_0_hsl(0_0%_100%/0.5)] hover:border-primary/25 hover:bg-accent/70 hover:text-accent-foreground",
        secondary:
          "bg-secondary/12 text-secondary border border-secondary/10 hover:bg-secondary/18 hover:text-secondary",
        ghost: "text-secondary/90 hover:bg-accent/70 hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-5 py-2.5",
        sm: "h-9 rounded-md px-3.5",
        lg: "h-12 rounded-lg px-8 text-[0.95rem]",
        icon: "h-10 w-10 rounded-lg",
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
