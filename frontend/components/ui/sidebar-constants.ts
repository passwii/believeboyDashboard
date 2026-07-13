/**
 * Shared constants for the Sidebar component family.
 * Kept in a separate file so `next/dynamic` can import
 * `SidebarMobileSheet` without dragging the desktop constants
 * (or the Radix Sheet module) into the desktop chunk.
 */
export const SIDEBAR_WIDTH = '12rem'
export const SIDEBAR_WIDTH_MOBILE = '20rem'
export const SIDEBAR_WIDTH_ICON = '4.25rem'
