"use client"

import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "@/lib/utils"

const Tabs = TabsPrimitive.Root

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex min-h-11 items-center justify-center gap-1 rounded-2xl border border-[hsl(var(--surface-high))/0.9] bg-[linear-gradient(180deg,hsl(var(--surface-soft))/0.94,hsl(var(--surface-subtle))/0.98)] p-1.5 text-muted-foreground shadow-[inset_0_1px_0_hsl(0_0%_100%/0.72),inset_0_-1px_0_hsl(214_18%_82%/0.38),0_10px_24px_-20px_rgba(15,23,42,0.12)] dark:border-[hsl(var(--surface-outline))/0.22] dark:bg-[linear-gradient(180deg,hsl(var(--surface-soft))/0.88,hsl(var(--surface-low))/0.98)] dark:shadow-[inset_0_1px_0_hsl(220_30%_100%/0.03),inset_0_-1px_0_rgba(0,0,0,0.28),0_20px_44px_-34px_rgba(0,0,0,0.82)]",
      className
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "relative inline-flex min-h-[2.85rem] items-center justify-center whitespace-nowrap rounded-[calc(theme(borderRadius.2xl)-0.25rem)] border border-transparent px-4 py-2.5 text-sm font-semibold text-[hsl(218_19%_39%)] ring-offset-background transition-[color,background-color,border-color,box-shadow,transform,filter] [transition-duration:var(--motion-fast)] [transition-timing-function:var(--motion-ease-out)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:-translate-y-px data-[state=active]:border-[hsl(0_0%_100%/0.96)] data-[state=active]:bg-[linear-gradient(180deg,hsl(0_0%_100%/1),hsl(210_20%_99%/1))] data-[state=active]:text-[hsl(222_33%_16%)] data-[state=active]:shadow-[0_1px_0_hsl(0_0%_100%/1),0_10px_22px_-14px_rgba(15,23,42,0.18),0_2px_6px_rgba(15,23,42,0.06)] data-[state=active]:brightness-[1.01] data-[state=active]:[transition-duration:var(--motion-base)] dark:text-[hsl(220_14%_72%)] dark:hover:bg-[hsl(var(--surface-overlay))/0.36] dark:hover:text-white dark:data-[state=active]:border-[hsl(var(--primary))/0.22] dark:data-[state=active]:bg-[linear-gradient(180deg,hsl(226_30%_22%/0.98),hsl(225_30%_17%/1))] dark:data-[state=active]:text-white dark:data-[state=active]:shadow-[0_0_0_1px_hsl(var(--primary)/0.12),0_0_24px_-10px_hsl(var(--primary)/0.62),0_14px_28px_-18px_rgba(0,0,0,0.8),inset_0_1px_0_hsl(220_30%_100%/0.12)] dark:data-[state=active]:brightness-[1.12]",
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-0 w-full ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=active]:animate-enter motion-reduce:data-[state=active]:animate-none",
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
