'use client'

import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

import styles from './warm-crm-kit.module.css'

export type WarmCrmRecordDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  children: ReactNode
  className?: string
}

export function WarmCrmRecordDrawer({
  open,
  onOpenChange,
  title,
  actions,
  footer,
  children,
  className,
}: WarmCrmRecordDrawerProps) {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal container={portalContainer}>
        <DialogPrimitive.Overlay className={styles.drawerOverlay} />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(styles.drawerContent, className)}
          data-warm-crm-record-drawer
        >
          <header className={styles.drawerHeader}>
            <DialogPrimitive.Title className={styles.drawerTitle}>
              {title}
            </DialogPrimitive.Title>
            {actions ? <div className={styles.drawerActions}>{actions}</div> : null}
            <DialogPrimitive.Close className={styles.drawerClose} aria-label="关闭">
              <X aria-hidden="true" />
            </DialogPrimitive.Close>
          </header>
          <div className={styles.drawerBody}>{children}</div>
          {footer ? <footer className={styles.drawerFooter}>{footer}</footer> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
