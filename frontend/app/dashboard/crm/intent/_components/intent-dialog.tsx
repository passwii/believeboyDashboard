'use client'

import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

import styles from '../intent-warm.module.css'

/**
 * 页面本地 V4 弹层（导入批次 / 号码共用）。
 *
 * 直接使用 Radix Dialog 原语 + 页面 CSS Module，避免 components/ui/dialog 的
 * term-* 历史默认样式；portal 与 WarmCrmRecordDrawer 一致，挂到
 * #warm-ledger-portal-root 以继承 Warm token。
 */
export type IntentDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
}

export function IntentDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: IntentDialogProps) {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal container={portalContainer}>
        <DialogPrimitive.Overlay className={styles.dialogOverlay} />
        <DialogPrimitive.Content
          {...(description ? {} : { 'aria-describedby': undefined })}
          className={cn(styles.dialogContent, className)}
          data-intent-dialog
        >
          <header className={styles.dialogHeader}>
            <DialogPrimitive.Title className={styles.dialogTitle}>{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close className={styles.dialogClose} aria-label="关闭">
              <X aria-hidden="true" />
            </DialogPrimitive.Close>
          </header>
          {description ? (
            <DialogPrimitive.Description className={styles.dialogDescription}>
              {description}
            </DialogPrimitive.Description>
          ) : null}
          <div className={styles.dialogBody}>{children}</div>
          {footer ? <footer className={styles.dialogFooter}>{footer}</footer> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
