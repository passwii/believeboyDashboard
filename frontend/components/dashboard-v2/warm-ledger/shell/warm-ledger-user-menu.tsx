'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { LogOut, Monitor, Moon, Sun, UserRound } from 'lucide-react'
import { useTheme } from 'next-themes'

import { useRouter } from 'next/navigation'
import { WarmIconButton } from '../controls'

type ThemeMode = 'light' | 'dark' | 'system'

type WarmLedgerUserMenuProps = {
  userLabel: string
  profileHref?: string
  onUserAction?: () => void
}

const MENU_CLOSE_DELAY_MS = 160

export function WarmLedgerUserMenu({
  userLabel,
  profileHref,
  onUserAction,
}: WarmLedgerUserMenuProps) {
  const { theme, setTheme } = useTheme()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openSourceRef = useRef<'hover' | 'interaction' | null>(null)
  const mode: ThemeMode = theme === 'light' || theme === 'dark' ? theme : 'system'

  useEffect(() => {
    setPortalContainer(
      document.getElementById('warm-ledger-portal-root') ?? document.body
    )
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    }
  }, [])

  const cancelClose = useCallback(() => {
    if (!closeTimerRef.current) return
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const scheduleClose = useCallback(() => {
    cancelClose()
    closeTimerRef.current = setTimeout(() => {
      setOpen(false)
      openSourceRef.current = null
      closeTimerRef.current = null
    }, MENU_CLOSE_DELAY_MS)
  }, [cancelClose])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      cancelClose()
      setOpen(nextOpen)
      if (nextOpen) {
        openSourceRef.current ??= 'interaction'
      } else {
        openSourceRef.current = null
      }
    },
    [cancelClose]
  )

  const selectMode = useCallback(
    (nextMode: string) => {
      if (nextMode !== 'light' && nextMode !== 'dark' && nextMode !== 'system') return
      setTheme(nextMode)
      handleOpenChange(false)
    },
    [handleOpenChange, setTheme]
  )
  const hoverFocusBehavior = {
    onOpenAutoFocus: (event: Event) => {
      if (openSourceRef.current === 'hover' && document.activeElement !== triggerRef.current) {
        event.preventDefault()
      }
    },
  }

  return (
    <DropdownMenuPrimitive.Root
      open={open}
      onOpenChange={handleOpenChange}
      modal={false}
    >
      <DropdownMenuPrimitive.Trigger asChild>
        <WarmIconButton
          ref={triggerRef}
          className="warm-ledger__topbar-action warm-ledger__topbar-action--secondary warm-ledger__profile-action"
          aria-label={userLabel}
          title={userLabel}
          data-testid="warm-ledger-user-menu-trigger"
          onPointerEnter={(event) => {
            if (event.pointerType !== 'mouse') return
            cancelClose()
            if (!open) {
              openSourceRef.current = 'hover'
              setOpen(true)
            }
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse') scheduleClose()
          }}
          onPointerDown={(event) => {
            if (event.pointerType !== 'mouse') return
            if (open && openSourceRef.current === 'hover') {
              openSourceRef.current = 'interaction'
              event.preventDefault()
            } else if (!open) {
              openSourceRef.current = 'interaction'
            }
          }}
        >
          <UserRound aria-hidden="true" />
        </WarmIconButton>
      </DropdownMenuPrimitive.Trigger>

      {portalContainer ? (
        <DropdownMenuPrimitive.Portal container={portalContainer}>
          <DropdownMenuPrimitive.Content
            className="warm-ledger__account-menu-content"
            side="bottom"
            align="end"
            sideOffset={8}
            {...hoverFocusBehavior}
            onPointerEnter={(event) => {
              if (event.pointerType === 'mouse') cancelClose()
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === 'mouse') scheduleClose()
            }}
          >
            <DropdownMenuPrimitive.Label className="warm-ledger__account-menu-label">
              外观模式
            </DropdownMenuPrimitive.Label>
            <DropdownMenuPrimitive.RadioGroup
              aria-label="主题模式"
              value={mode}
              onValueChange={selectMode}
            >
              <DropdownMenuPrimitive.RadioItem
                className="warm-ledger__account-menu-item"
                value="light"
              >
                <span className="warm-ledger__account-menu-indicator" aria-hidden="true">
                  <DropdownMenuPrimitive.ItemIndicator>
                    <span aria-hidden="true">✓</span>
                  </DropdownMenuPrimitive.ItemIndicator>
                </span>
                <Sun aria-hidden="true" />
                <span>浅色模式</span>
              </DropdownMenuPrimitive.RadioItem>
              <DropdownMenuPrimitive.RadioItem
                className="warm-ledger__account-menu-item"
                value="dark"
              >
                <span className="warm-ledger__account-menu-indicator" aria-hidden="true">
                  <DropdownMenuPrimitive.ItemIndicator>
                    <span aria-hidden="true">✓</span>
                  </DropdownMenuPrimitive.ItemIndicator>
                </span>
                <Moon aria-hidden="true" />
                <span>深色模式</span>
              </DropdownMenuPrimitive.RadioItem>
              <DropdownMenuPrimitive.RadioItem
                className="warm-ledger__account-menu-item"
                value="system"
              >
                <span className="warm-ledger__account-menu-indicator" aria-hidden="true">
                  <DropdownMenuPrimitive.ItemIndicator>
                    <span aria-hidden="true">✓</span>
                  </DropdownMenuPrimitive.ItemIndicator>
                </span>
                <Monitor aria-hidden="true" />
                <span>跟随系统</span>
              </DropdownMenuPrimitive.RadioItem>
            </DropdownMenuPrimitive.RadioGroup>

            <DropdownMenuPrimitive.Separator className="warm-ledger__account-menu-separator" />

            {profileHref ? (
              <DropdownMenuPrimitive.Item
                className="warm-ledger__account-menu-item"
                onSelect={() => router.push(profileHref)}
              >
                个人中心
              </DropdownMenuPrimitive.Item>
            ) : onUserAction ? (
              <DropdownMenuPrimitive.Item
                className="warm-ledger__account-menu-item"
                onSelect={onUserAction}
              >
                个人中心
              </DropdownMenuPrimitive.Item>
            ) : null}
            <DropdownMenuPrimitive.Item
              className="warm-ledger__account-menu-item"
              onSelect={() => router.push('/dashboard/change-password')}
            >
              修改密码
            </DropdownMenuPrimitive.Item>
            <DropdownMenuPrimitive.Item
              className="warm-ledger__account-menu-item"
              onSelect={() => router.push('/dashboard/feature-updates')}
            >
              产品更新
            </DropdownMenuPrimitive.Item>

            <DropdownMenuPrimitive.Separator className="warm-ledger__account-menu-separator" />

            <DropdownMenuPrimitive.Item
              className="warm-ledger__account-menu-item"
              onSelect={() => window.dispatchEvent(new CustomEvent('believeboy:logout'))}
            >
              <LogOut aria-hidden="true" />
              <span>退出登录</span>
            </DropdownMenuPrimitive.Item>
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      ) : null}
    </DropdownMenuPrimitive.Root>
  )
}
