'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import styles from './account-management-warm.module.css'

const Dialog = DialogPrimitive.Root

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null)

  React.useEffect(() => {
    setPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

  return (
    <DialogPrimitive.Portal container={portalContainer}>
      <DialogPrimitive.Overlay className={styles.dialogOverlay} />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(styles.dialog, 'ui-modal-motion', className)}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className={styles.dialogClose} aria-label="关闭">
          <X aria-hidden />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn(styles.dialogHeader, className)} {...props} />
)

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn(styles.dialogFooter, className)} {...props} />
)

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(styles.dialogTitle, className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn(styles.dialogDescription, className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
}
