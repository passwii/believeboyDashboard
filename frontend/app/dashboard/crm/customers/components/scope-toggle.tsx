'use client'

import { useCrmDataScope } from '@/hooks/use-crm-data-scope'
import { WarmSegmentedControl } from '@/components/dashboard-v2/warm-ledger/controls'

/** 数据范围切换（mine/all）：沿用 URL scope 语义，视觉使用 Warm 分段控件。 */
export function ScopeToggle() {
  const { scope, setScope } = useCrmDataScope()
  return (
    <WarmSegmentedControl
      ariaLabel="数据范围"
      value={scope}
      options={[
        { value: 'mine', label: '我的' },
        { value: 'all', label: '全部' },
      ]}
      onChange={setScope}
    />
  )
}
