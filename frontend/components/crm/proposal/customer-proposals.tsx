'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Plus } from 'lucide-react'

import {
  WarmCrmSection,
  WarmCrmState,
} from '@/components/dashboard-v2/warm-ledger/crm'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { useCrmDataScope } from '@/hooks/use-crm-data-scope'
import type { Proposal } from '@/lib/crm/types'
import { ProposalStatusPill, ProposalTypePill } from './pill'
import styles from './proposal-warm.module.css'

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

/**
 * `customer_id` 在后端是 int 列，筛选值必须传 number。
 *
 * 传数字字符串时 SQLAlchemy 按 varchar 绑参，PostgreSQL 会报
 * `operator does not exist: integer = character varying`，整个列表接口 500
 * （客户抽屉「关联方案」即由此打不开）。demo / mock 的客户 id 是 `c-xxx`
 * 形式，非纯数字时按原值传，保持 mock 端可筛。
 */
function toCustomerFilterValue(customerId: string): string | number {
  return /^\d+$/.test(customerId) ? Number(customerId) : customerId
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
          filters: [
            { field: 'customer_id', op: 'eq', value: toCustomerFilterValue(customerId) },
          ],
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
    <WarmCrmSection
      actions={
        <Link
          href="/dashboard/crm/proposals"
          className={`${styles.linkButton} ${styles.linkButtonCompact}`}
          title="前往客户方案页"
        >
          <ArrowUpRight aria-hidden="true" />
          方案页
        </Link>
      }
      className={className}
      data-testid="customer-proposals"
      title={`关联方案${loading ? '' : `（${items.length}）`}`}
    >
      {loading ? (
        <WarmCrmState kind="loading" title="加载关联方案…" />
      ) : error ? (
        <WarmCrmState kind="error" title={`ERR · ${error}`} />
      ) : items.length === 0 ? (
        <WarmCrmState
          action={
            <Link
              href="/dashboard/crm/proposals"
              className={`${styles.linkButton} ${styles.linkButtonCompact}`}
            >
              <Plus aria-hidden="true" />
              新建方案
            </Link>
          }
          kind="empty"
          title="该客户还没有关联方案。新建方案时在「关联客户」里选择此客户即可关联。"
        />
      ) : (
        <ul className={styles.customerList}>
          {items.map((p) => (
            <li
              key={p.id}
              className={styles.customerItem}
              data-testid={`customer-proposal-${p.id}`}
            >
              <div className={styles.customerMain}>
                <Link
                  href={`/dashboard/crm/proposals/${p.id}`}
                  className={styles.customerTitle}
                  title={p.title}
                >
                  {p.title}
                </Link>
                <ProposalTypePill type={p.proposalType} />
                <ProposalStatusPill status={p.status} />
              </div>
              <div className={styles.customerMeta}>
                <span>
                  v{p.currentVersionNo} · {p.versionCount} 版
                </span>
                <span>{new Date(p.updatedAt).toLocaleString('zh-CN', { hour12: false })}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </WarmCrmSection>
  )
}
