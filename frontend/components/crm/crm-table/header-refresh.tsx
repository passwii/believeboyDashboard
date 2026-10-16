'use client'

import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'

/** 主表格的显式 Head 桥接；放在独立组件中，避免非页面表格依赖 Header Provider。 */
export function CrmTableHeaderRefresh({
  refresh,
  loading,
}: {
  refresh: () => Promise<void>
  loading: boolean
}) {
  useHeaderRefresh(refresh, { loading })
  return null
}
