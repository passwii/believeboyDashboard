'use client'

/**
 * 漏斗二层复盘面板（BLF-518）——右侧抽屉。
 */
import { useEffect, useRef, useState } from 'react'
import {
  Clock3,
  Hourglass,
  RefreshCcw,
  UserRound,
} from 'lucide-react'
import {
  WarmButton,
  WarmSegmentedControl,
} from '@/components/dashboard-v2/warm-ledger/controls'
import {
  WarmCrmRecordDrawer,
  WarmCrmState,
  WarmCrmStatusPill,
  WarmCrmTableScroller,
} from '@/components/dashboard-v2/warm-ledger/crm'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import type { FunnelStageDetail, StageLeadItem } from '@/lib/crm/types'
import { formatRelativeTime } from '@/lib/crm/method/format'

import styles from './funnel-stage-drawer.module.css'

export interface FunnelStageDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 后端阶段 key：new / contacting / qualified / converted。 */
  stage: string
  /** 阶段展示名（新线索/联系中/已验证/已转化）。 */
  stageLabel: string
}

const PAGE_SIZE = 10

/** 停留时长展示：7.5 → "7.5 天"，整数 → "7 天"。 */
function formatDwell(days?: number): string {
  if (days == null) return '—'
  const rounded = Math.round(days * 10) / 10
  return `${rounded} 天`
}

function LeadRow({ item, rank }: { item: StageLeadItem; rank: number }) {
  return (
    <tr data-stuck={item.isStuck ? 'true' : undefined}>
      <td>
        <div className={styles.leadIdentity}>
          {rank <= 3 ? <span className={styles.rank}>{rank}</span> : null}
          <div className={styles.leadCopy}>
            <span className={styles.leadName}>{item.name}</span>
            {item.company ? <span className={styles.leadCompany}>{item.company}</span> : null}
          </div>
        </div>
      </td>
      <td>
        <span className={styles.owner}>
          <UserRound aria-hidden="true" />
          {item.ownerName ?? '未分配'}
        </span>
      </td>
      <td>
        <span className={styles.dwell}>
          <Hourglass aria-hidden="true" />
          <span data-stuck={item.isStuck ? 'true' : undefined}>
            {formatDwell(item.dwellDays)}
          </span>
          {item.isStuck ? <WarmCrmStatusPill tone="accent">卡住</WarmCrmStatusPill> : null}
        </span>
      </td>
      <td>
        {item.lastActionAt ? (
          <span className={styles.actionCell}>
            <span className={styles.actionTime}>
              <Clock3 aria-hidden="true" />
              {formatRelativeTime(item.lastActionAt)}
            </span>
            {item.lastActionContent ? (
              <span className={styles.actionContent}>{item.lastActionContent}</span>
            ) : null}
          </span>
        ) : (
          <span className={styles.muted}>无跟进记录</span>
        )}
      </td>
      <td>
        {item.nextFollowAt ? (
          <span className={styles.numeric}>{formatRelativeTime(item.nextFollowAt)}</span>
        ) : (
          <span className={styles.muted}>—</span>
        )}
      </td>
    </tr>
  )
}

export function FunnelStageDrawer({
  open,
  onOpenChange,
  stage,
  stageLabel,
}: FunnelStageDrawerProps) {
  const client = useCrmClient()
  const [sortBy, setSortBy] = useState<'dwell' | 'recent'>('dwell')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<FunnelStageDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // client 在生产环境稳定；测试环境可能每次渲染生成新对象，effect 只依赖打开状态、
  // 排序和页码，加载器内部读取最新闭包。
  const loadRef = useRef<() => void>(() => {})
  loadRef.current = () => {
    setLoading(true)
    setError(null)
    void client
      .getFunnelStageDetail({ stage, sortBy, page, pageSize: PAGE_SIZE })
      .then((detail) => setData(detail))
      .catch((requestError: unknown) =>
        setError(requestError instanceof Error ? requestError.message : '加载阶段明细失败')
      )
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (open) loadRef.current()
  }, [open, sortBy, page])

  function handleSortChange(next: 'dwell' | 'recent') {
    if (next === sortBy) return
    setSortBy(next)
    setPage(1)
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1

  return (
    <WarmCrmRecordDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={`${stageLabel} · 复盘明细`}
      actions={
        <WarmButton
          variant="quiet"
          onClick={() => loadRef.current()}
          disabled={loading}
          aria-label="刷新阶段明细"
        >
          <RefreshCcw aria-hidden="true" />
          刷新
        </WarmButton>
      }
      footer={
        data && data.total > data.pageSize ? (
          <div className={styles.footer}>
            <span>
              共 {data.total} 条 · 第 {data.page}/{totalPages} 页
            </span>
            <div className={styles.footerActions}>
              <WarmButton
                disabled={data.page <= 1 || loading}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                上一页
              </WarmButton>
              <WarmButton
                disabled={data.page >= totalPages || loading}
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              >
                下一页
              </WarmButton>
            </div>
          </div>
        ) : undefined
      }
    >
      {data ? (
        <div className={styles.summary}>
          <span>
            <Hourglass aria-hidden="true" />
            平均停留 {data.avgDwellDays != null ? `${data.avgDwellDays} 天` : '—'}
          </span>
          <WarmCrmStatusPill tone={data.stuckCount > 0 ? 'accent' : 'neutral'}>
            卡住 {data.stuckCount} 条（超 {data.stuckDays} 天未动）
          </WarmCrmStatusPill>
          <span>本期流入 {data.inflow}</span>
          {data.outflow != null ? <span>流出 {data.outflow}</span> : null}
        </div>
      ) : null}

      <WarmSegmentedControl
        ariaLabel="排序视图"
        value={sortBy}
        options={[
          { value: 'dwell', label: '卡点列表' },
          { value: 'recent', label: '最近动作' },
        ]}
        onChange={(value) => handleSortChange(value as 'dwell' | 'recent')}
      />

      {error ? (
        <WarmCrmState
          kind="error"
          title="加载失败"
          detail={error}
          action={<WarmButton onClick={() => loadRef.current()}>重试</WarmButton>}
        />
      ) : loading && !data ? (
        <WarmCrmState kind="loading" title="加载中" />
      ) : data && data.leads.length === 0 ? (
        <WarmCrmState kind="empty" title="该阶段暂无线索明细" />
      ) : data ? (
        <WarmCrmTableScroller ariaLabel="阶段线索表格">
          <table>
            <thead>
              <tr>
                <th>线索</th>
                <th>负责人</th>
                <th>停留</th>
                <th>最后动作</th>
                <th>下次跟进</th>
              </tr>
            </thead>
            <tbody>
              {data.leads.map((item, index) => (
                <LeadRow
                  key={item.id}
                  item={item}
                  rank={(data.page - 1) * data.pageSize + index + 1}
                />
              ))}
            </tbody>
          </table>
        </WarmCrmTableScroller>
      ) : null}
    </WarmCrmRecordDrawer>
  )
}

export default FunnelStageDrawer
