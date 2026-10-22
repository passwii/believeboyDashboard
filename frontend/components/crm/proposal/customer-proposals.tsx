'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Loader2, Plus } from 'lucide-react'

import { TERM_BUTTON } from '@/components/crm/term-shared'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmDataScope } from '@/hooks/use-crm-data-scope'
import type { Proposal } from '@/lib/crm/types'
import { ProposalStatusPill, ProposalTypePill } from './pill'

/**
 * 客户详情抽屉里的「方案」Tab：列出该客户关联的客户方案。
 *
 * 数据源与方案列表页同一个 `listProposals`，用 `customer_id` 白名单筛选
 * （后端 PROPOSAL_FILTER_FIELDS 已含 customer_id）。只读，点标题跳到方案详情，
 * 那边能看到客户名 / 版本链，形成双向可查。
 */
export interface CustomerProposalsProps {
  customerId: string
  className?: string
}

export function CustomerProposals({ customerId, className }: CustomerProposalsProps) {
  const client = useCrmClient()
  const { scope } = useCrmDataScope()
  const [items, setItems] = useState<Proposal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!customerId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const page = await client.listProposals({
          scope,
          // 值保持字符串（mock 与 DTO 的 id 都是字符串；后端 int 列可隐式转换）。
          filters: [{ field: 'customer_id', op: 'eq', value: customerId }],
          sortBy: 'updated_at',
          sortOrder: 'desc',
          pageSize: 50,
        })
        if (!cancelled) setItems(page.items)
      } catch (e) {
        if (!cancelled) {
          setItems([])
          setError(e instanceof Error ? e.message : '加载关联方案失败')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, customerId, scope])

  return (
    <section className={className} data-testid="customer-proposals">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-mono text-xs uppercase tracking-wider text-term-muted">
          关联方案{loading ? '' : `（${items.length}）`}
        </h3>
        <Link
          href="/dashboard/crm/proposals"
          className={`${TERM_BUTTON} h-7 gap-1 px-1.5`}
          title="前往客户方案页"
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
          方案页
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center gap-1.5 border border-term-border px-2 py-6 font-mono text-xs text-term-faint">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          加载关联方案…
        </div>
      ) : error ? (
        <p
          role="alert"
          className="border border-term-neg/50 bg-term-neg/10 px-2 py-1.5 font-mono text-xs text-term-neg"
        >
          ERR · {error}
        </p>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-start gap-2 border border-term-border px-2 py-4">
          <p className="font-mono text-xs text-term-faint">
            该客户还没有关联方案。新建方案时在「关联客户」里选择此客户即可关联。
          </p>
          <Link href="/dashboard/crm/proposals" className={`${TERM_BUTTON} h-7 gap-1 px-1.5`}>
            <Plus className="h-3.5 w-3.5" />
            新建方案
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((p) => (
            <li
              key={p.id}
              className="border border-term-border bg-term-panel px-2 py-1.5"
              data-testid={`customer-proposal-${p.id}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/dashboard/crm/proposals/${p.id}`}
                  className="min-w-0 flex-1 truncate text-xs text-term-text hover:underline"
                  title={p.title}
                >
                  {p.title}
                </Link>
                <ProposalTypePill type={p.proposalType} />
                <ProposalStatusPill status={p.status} />
              </div>
              <div className="mt-1 flex items-center justify-between font-mono text-[11px] text-term-faint">
                <span>
                  v{p.currentVersionNo} · {p.versionCount} 版
                </span>
                <span>{new Date(p.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
