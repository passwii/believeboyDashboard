'use client'

import { createContext, useCallback, useContext, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'

interface ConfirmOptions {
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  variant?: 'default' | 'destructive'
  /**
   * 键入确认（BLF-468）：设置后弹窗内出现输入框，确认按钮在输入与
   * expectedInput 完全匹配前保持禁用——用于删除等不可逆操作防手滑。
   */
  inputLabel?: string
  expectedInput?: string
}

type ResolveFn = (value: boolean) => void

type ConfirmContextValue = {
  confirm: (opts: ConfirmOptions) => Promise<boolean>
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null)

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<ConfirmOptions>({
    title: '',
  })
  const [typedValue, setTypedValue] = useState('')
  const resolveRef = useRef<ResolveFn | null>(null)

  const requiresTyping = Boolean(options.expectedInput)
  const typedMatch =
    requiresTyping && options.expectedInput != null
      ? typedValue.trim() === options.expectedInput
      : true

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
      setOptions(opts)
      setTypedValue('')
      setOpen(true)
    })
  }, [])

  const handleConfirm = useCallback(() => {
    if (requiresTyping && !typedMatch) return
    setOpen(false)
    resolveRef.current?.(true)
    resolveRef.current = null
  }, [requiresTyping, typedMatch])

  const handleCancel = useCallback(() => {
    setOpen(false)
    resolveRef.current?.(false)
    resolveRef.current = null
  }, [])

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      <AlertDialog
        open={open}
        onOpenChange={(v) => {
          if (!v) handleCancel()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{options.title}</AlertDialogTitle>
            {options.description && (
              <AlertDialogDescription>{options.description}</AlertDialogDescription>
            )}
            {requiresTyping && (
              <div className="mt-2">
                <label
                  htmlFor="confirm-typed-input"
                  className="mb-1.5 block text-sm font-medium text-foreground"
                >
                  {options.inputLabel ?? '请输入确认内容'}
                </label>
                <input
                  id="confirm-typed-input"
                  value={typedValue}
                  onChange={(e) => setTypedValue(e.target.value)}
                  className={cn(
                    'w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm',
                    typedValue && !typedMatch && 'border-destructive'
                  )}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={options.inputLabel ?? '确认输入'}
                />
              </div>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancel}>
              {options.cancelText ?? '取消'}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirm}
              disabled={requiresTyping && !typedMatch}
              className={cn(
                options.variant === 'destructive' &&
                  'bg-destructive text-destructive-foreground hover:bg-destructive/90'
              )}
            >
              {options.confirmText ?? '确认'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext)
  if (!ctx) {
    throw new Error('useConfirm must be used within ConfirmProvider')
  }
  return ctx
}
