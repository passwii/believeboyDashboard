'use client'

import * as React from 'react'
import { useTheme } from 'next-themes'
import { Monitor, Moon, Sun } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { TERMINAL_RAIL_ICON_SIZE } from '@/components/terminal/terminal-constants'

type ThemeMode = 'light' | 'dark' | 'system'

interface ThemeModePickerProps {
  placement: 'rail' | 'mobile'
}

const THEME_TRANSITION_DURATION_MS = 240
const MENU_CLOSE_DELAY_MS = 160
let themeTransitionTimer: ReturnType<typeof setTimeout> | null = null

function beginThemeTransition() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const root = document.documentElement
  root.setAttribute('data-theme-transition', 'true')
  if (themeTransitionTimer) clearTimeout(themeTransitionTimer)
  themeTransitionTimer = setTimeout(() => {
    root.removeAttribute('data-theme-transition')
    themeTransitionTimer = null
  }, THEME_TRANSITION_DURATION_MS)
}

export function ThemeModePicker({ placement }: ThemeModePickerProps) {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const [animateIcon, setAnimateIcon] = React.useState(false)
  const openSourceRef = React.useRef<'hover' | 'click' | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverOpenTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const isRail = placement === 'rail'
  const mode: ThemeMode =
    mounted && (theme === 'light' || theme === 'dark') ? theme : 'system'

  React.useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
      if (hoverOpenTimerRef.current) clearTimeout(hoverOpenTimerRef.current)
    }, []
  )

  React.useEffect(() => {
    setMounted(true)
  }, [])

  React.useEffect(() => {
    if (!animateIcon) return
    const timer = setTimeout(() => setAnimateIcon(false), 180)
    return () => clearTimeout(timer)
  }, [animateIcon])

  const cancelClose = React.useCallback(() => {
    if (!closeTimerRef.current) return
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const cancelHoverOpen = React.useCallback(() => {
    if (!hoverOpenTimerRef.current) return
    clearTimeout(hoverOpenTimerRef.current)
    hoverOpenTimerRef.current = null
  }, [])

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      cancelClose()
      cancelHoverOpen()
      setOpen(nextOpen)
      if (!nextOpen) openSourceRef.current = null
    },
    [cancelClose, cancelHoverOpen]
  )

  const scheduleClose = React.useCallback(() => {
    cancelClose()
    closeTimerRef.current = setTimeout(() => {
      handleOpenChange(false)
      closeTimerRef.current = null
    }, MENU_CLOSE_DELAY_MS)
  }, [cancelClose, handleOpenChange])

  const selectMode = React.useCallback(
    (nextMode: string) => {
      if (nextMode !== 'light' && nextMode !== 'dark' && nextMode !== 'system') return
      if (nextMode !== mode) {
        beginThemeTransition()
        setAnimateIcon(true)
        setTheme(nextMode)
      }
      setOpen(false)
    },
    [mode, setTheme]
  )

  const handleRadioValueChange = React.useCallback(
    (nextMode: string) => {
      selectMode(nextMode)
      handleOpenChange(false)
    },
    [handleOpenChange, selectMode]
  )

  const Icon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor
  const buttonLabel = isRail ? `主题设置：${modeLabel(mode)}` : `外观：${modeLabel(mode)}`

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange} modal={!isRail}>
      <DropdownMenuTrigger asChild>
        {isRail ? (
          <button
            ref={triggerRef}
            type="button"
            aria-label={buttonLabel}
            title={`主题：${modeLabel(mode)}`}
            className="flex h-9 w-9 items-center justify-center rounded-none text-term-muted shadow-none transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-term-accent"
            onPointerEnter={(event) => {
              if (event.pointerType === 'mouse') {
                cancelClose()
                if (!open) {
                  cancelHoverOpen()
                  hoverOpenTimerRef.current = setTimeout(() => {
                    openSourceRef.current = 'hover'
                    setOpen(true)
                    hoverOpenTimerRef.current = null
                  }, 80)
                }
              }
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === 'mouse') {
                cancelHoverOpen()
                scheduleClose()
              }
            }}
            onPointerDown={(event) => {
              if (event.pointerType !== 'mouse') return
              cancelHoverOpen()
              if (open && openSourceRef.current === 'hover') {
                openSourceRef.current = 'click'
                event.preventDefault()
              } else if (!open) {
                openSourceRef.current = 'click'
              }
            }}
          >
            <Icon
              className={animateIcon ? 'theme-mode-icon-animate shrink-0' : 'shrink-0'}
              style={{ height: TERMINAL_RAIL_ICON_SIZE, width: TERMINAL_RAIL_ICON_SIZE }}
              strokeWidth={1.75}
            />
          </button>
        ) : (
          <button
            type="button"
            aria-label={buttonLabel}
            className="flex h-10 w-full items-center gap-2 rounded-none px-3 text-left text-sm text-term-muted transition-colors hover:bg-term-hover hover:text-term-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-term-accent"
          >
            <Icon
              className={animateIcon ? 'theme-mode-icon-animate h-4 w-4 shrink-0' : 'h-4 w-4 shrink-0'}
              strokeWidth={1.75}
            />
            <span className="flex-1">外观</span>
            <span className="text-xs text-term-faint">{modeLabel(mode)}</span>
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={isRail ? 'right' : 'top'}
        align={isRail ? 'end' : 'start'}
        sideOffset={8}
        onOpenAutoFocus={(event) => {
          if (isRail && openSourceRef.current === 'hover' && document.activeElement !== triggerRef.current) {
            event.preventDefault()
          }
        }}
        onPointerEnter={(event) => {
          if (isRail && event.pointerType === 'mouse') cancelClose()
        }}
        onPointerLeave={(event) => {
          if (isRail && event.pointerType === 'mouse') scheduleClose()
        }}
        className="min-w-48 rounded-none border-term-border bg-term-panel text-term-text"
      >
        <DropdownMenuLabel>外观模式</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={mode} onValueChange={handleRadioValueChange}>
          <DropdownMenuRadioItem value="light" className="rounded-none">
            <Sun className="h-4 w-4" />
            浅色
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark" className="rounded-none">
            <Moon className="h-4 w-4" />
            深色
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system" className="rounded-none">
            <Monitor className="h-4 w-4" />
            自动（跟随系统）
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function modeLabel(mode: ThemeMode): string {
  if (mode === 'light') return '浅色'
  if (mode === 'dark') return '深色'
  return '自动'
}
