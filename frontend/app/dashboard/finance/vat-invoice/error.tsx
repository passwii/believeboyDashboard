'use client'

import { useEffect } from 'react'

import { StatusPageShell, StatusHomeAction } from '@/components/system/status-page-shell'
import { StatusRetryButton } from '@/components/system/status-retry-button'

export default function VatInvoiceError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[VAT Invoice] page error:', error)
  }, [error])

  return (
    <StatusPageShell
      code="VAT"
      title="VAT 发票生成器暂不可用"
      description="VAT 发票页面遇到问题，请尝试刷新页面。如果问题持续存在，请联系管理员。"
      tone="error"
      compact
      primaryAction={<StatusRetryButton onClick={reset} />}
      secondaryAction={<StatusHomeAction href="/dashboard" />}
    />
  )
}
