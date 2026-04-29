'use client'

import { Loader2, RefreshCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface RefreshButtonProps {
  onClick: () => void | Promise<void>
  loading?: boolean
  disabled?: boolean
  label?: string
  variant?: 'outline' | 'ghost' | 'default' | 'secondary' | 'destructive' | 'link'
  size?: 'default' | 'sm' | 'lg' | 'icon'
  className?: string
}

export function RefreshButton({
  onClick,
  loading = false,
  disabled = false,
  label,
  variant = 'outline',
  size = 'icon',
  className,
}: RefreshButtonProps) {
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={() => void onClick()}
      disabled={loading || disabled}
      className={cn('shrink-0', className)}
      title={label || '刷新'}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <RefreshCcw className="h-4 w-4" />
      )}
      {label && size !== 'icon' ? <span className="ml-2">{label}</span> : null}
    </Button>
  )
}