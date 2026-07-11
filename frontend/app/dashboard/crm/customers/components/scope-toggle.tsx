'use client'

import { useCrmDataScope } from '@/hooks/use-crm-data-scope'
import { cn } from '@/lib/utils'

export function ScopeToggle() {
 const { scope, setScope } = useCrmDataScope()
 return (
 <div
 role='radiogroup'
 aria-label='数据范围'
 className='inline-flex rounded-md border border-border/60 bg-background p-0.5 text-sm shadow-sm'
 >
 <button
 type='button'
 role='radio'
 aria-checked={scope === 'mine'}
 onClick={() => setScope('mine')}
 className={cn(
 'rounded px-3 py-1 transition-colors',
 scope === 'mine' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
 )}
 >
 我的
 </button>
 <button
 type='button'
 role='radio'
 aria-checked={scope === 'all'}
 onClick={() => setScope('all')}
 className={cn(
 'rounded px-3 py-1 transition-colors',
 scope === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
 )}
 >
 全部
 </button>
 </div>
 )
}