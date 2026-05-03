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
      "relative inline-flex min-h-[2.85rem] items-center justify-center whitespace-nowrap rounded-[calc(theme(borderRadius.2xl)-0.25rem)] border border-transparent px-4 py-2.5 text-sm font-semibold text-[hsl(218_19%_39%)] ring-offset-background transition-[color,background-color,border-color,box-shadow,transform,filter] [transition-duration:var(--motion-fast)] [transition-timing-function:var(--motion-ease-out)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:-translate-y-px data-[state=active]:border-[hsl(0_0%_100%/0.96)] data-[state=active]:bg-[linear-gradient(180deg,hsl(0_0%_100%/1),hsl(210_20%_99%/1))] data-[state=active]:text-[hsl(222_33%_16%)] data-[state=active]:shadow-[0_1px_0_hsl(0_0%_100%/1),0_10px_22px_-14px_rgba(15,23,42,0.18),0_2px_6px_rgba(15,23,42,0.06)] data-[state=active]:brightness-[1.01] data-[state=active]:[transition-duration:var(--motion-base)] data-[state=active]:[&::after]:content-[''] data-[state=active]:[&::after]:absolute data-[state=active]:[&::after]:bottom-0 data-[state=active]:[&::after]:left-1/2 data-[state=active]:[&::after]:-translate-x-1/2 data-[state=active]:[&::after]:w-[50%] data-[state=active]:[&::after]:h-[2px] data-[state=active]:[&::after]:rounded-full data-[state=active]:[&::after]:bg-[hsl(var(--primary))] data-[state=active]:[&::after]:shadow-[0_0_8px_hsl(var(--primary)/0.7),0_0_16px_hsl(var(--primary)/0.4)] dark:text-[hsl(220_14%_72%)] dark:hover:bg-[hsl(var(--surface-overlay))/0.36] dark:hover:text-white dark:data-[state=active]:border-[hsl(var(--surface-high))] dark:data-[state=active]:bg-[linear-gradient(180deg,hsl(var(--surface-high)/0.95),hsl(var(--surface-elevated)/0.98))] dark:data-[state=active]:text-white dark:data-[state=active]:shadow-[0_0_0_1px_hsl(var(--primary)/0.25),0_0_24px_-8px_hsl(var(--primary)/0.45),0_0_48px_-16px_hsl(var(--primary)/0.25),0_4px_12px_-4px_rgba(0,0,0,0.5),inset_0_1px_0_hsl(var(--surface-bright)/0.12)] dark:data-[state=active]:brightness-[1.08] dark:data-[state=active]:[&::after]:content-[''] dark:data-[state=active]:[&::after]:absolute dark:data-[state=active]:[&::after]:bottom-0 dark:data-[state=active]:[&::after]:left-1/2 dark:data-[state=active]:[&::after]:-translate-x-1/2 dark:data-[state=active]:[&::after]:w-[50%] dark:data-[state=active]:[&::after]:h-[2px] dark:data-[state=active]:[&::after]:rounded-full dark:data-[state=active]:[&::after]:bg-[hsl(var(--primary))] dark:data-[state=active]:[&::after]:shadow-[0_0_10px_hsl(var(--primary)/0.9),0_0_20px_hsl(var(--primary)/0.5)]",
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
