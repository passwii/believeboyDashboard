"use client"

import * as React from "react"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

import { SIDEBAR_WIDTH_MOBILE } from "./sidebar-constants"

/**
 * Mobile-only sidebar drawer. Lives in its own module so that
 * `next/dynamic({ ssr: false })` can keep @radix-ui/react-dialog out of the
 * desktop bundle. The parent `Sidebar` only renders this on `isMobile`,
 * which is always `false` during SSR (see useIsMobile).
 */
export interface SidebarMobileSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  side?: "left" | "right"
  children: React.ReactNode
}

export function SidebarMobileSheet({
  open,
  onOpenChange,
  side = "left",
  children,
}: SidebarMobileSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        data-sidebar="sidebar"
        data-mobile="true"
        className="w-[--sidebar-width] bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden"
        style={
          {
            "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
          } as React.CSSProperties
        }
        side={side}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Sidebar</SheetTitle>
          <SheetDescription>Displays the mobile sidebar.</SheetDescription>
        </SheetHeader>
        <div className="flex h-full w-full flex-col">{children}</div>
      </SheetContent>
    </Sheet>
  )
}
