'use client'

import * as React from 'react'
import {
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Search,
} from 'lucide-react'

import {
  WarmBadge,
  WarmButton,
  type WarmBadgeTone,
} from '@/components/dashboard-v2/warm-ledger/controls'

import styles from './table-showcase-warm.module.css'

type Status = 'success' | 'warning' | 'negative' | 'neutral'

type Order = {
  id: string
  customer: string
  status: Status
  statusLabel: string
  amount: number
  method: string
  date: string
  detail: { items: number; region: string; note: string }
}

const ORDERS: Order[] = [
  { id: 'INV-2041', customer: 'Aurora Labs', status: 'success', statusLabel: '已回款', amount: 2480.5, method: '信用卡', date: '07-12', detail: { items: 12, region: 'US-East', note: '月付订阅，自动续费正常。' } },
  { id: 'INV-2042', customer: 'Nimbus Retail', status: 'warning', statusLabel: '待对账', amount: 1190, method: 'PayPal', date: '07-12', detail: { items: 5, region: 'EU-DE', note: '跨境手续费待核销。' } },
  { id: 'INV-2043', customer: 'Vertex Co', status: 'negative', statusLabel: '已退票', amount: 760.25, method: '银行转账', date: '07-11', detail: { items: 3, region: 'US-West', note: '账户余额不足，已发起二次扣款。' } },
  { id: 'INV-2044', customer: 'Lumen Goods', status: 'success', statusLabel: '已回款', amount: 3120, method: '信用卡', date: '07-11', detail: { items: 21, region: 'US-East', note: '大额订单，物流已发货。' } },
  { id: 'INV-2045', customer: 'Quill Studio', status: 'neutral', statusLabel: '草稿', amount: 0, method: '—', date: '07-10', detail: { items: 0, region: '—', note: '报价草稿，待客户确认。' } },
  { id: 'INV-2046', customer: 'Beacon Inc', status: 'success', statusLabel: '已回款', amount: 540.8, method: 'PayPal', date: '07-10', detail: { items: 2, region: 'EU-UK', note: '小额续费。' } },
  { id: 'INV-2047', customer: 'Cobalt Trade', status: 'warning', statusLabel: '待对账', amount: 1980, method: '银行转账', date: '07-09', detail: { items: 9, region: 'US-West', note: '对公转账在途。' } },
  { id: 'INV-2048', customer: 'Slate Goods', status: 'success', statusLabel: '已回款', amount: 870.4, method: '信用卡', date: '07-09', detail: { items: 6, region: 'US-East', note: '常规采购。' } },
]

const fmt = (value: number) =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function statusTone(status: Status): WarmBadgeTone {
  if (status === 'success') return 'positive'
  if (status === 'warning') return 'accent'
  if (status === 'negative') return 'negative'
  return 'neutral'
}

function StatusBadge({ status, label }: { status: Status; label: string }) {
  return <WarmBadge tone={statusTone(status)}>{label}</WarmBadge>
}

function TableFrame({
  title,
  action,
  toolbar,
  footer,
  limited = false,
  children,
}: {
  title: string
  action?: React.ReactNode
  toolbar?: React.ReactNode
  footer?: React.ReactNode
  limited?: boolean
  children: React.ReactNode
}) {
  return (
    <section className={styles.tableFrame}>
      <div className={styles.tableFrameHeader}>
        <h3 className={styles.tableFrameTitle}>{title}</h3>
        {action ? <div className={styles.tableFrameAction}>{action}</div> : null}
      </div>
      {toolbar ? <div className={styles.toolbar}>{toolbar}</div> : null}
      <div
        className={[styles.tableScroll, limited ? styles.tableScrollLimited : '']
          .filter(Boolean)
          .join(' ')}
        data-warm-table-scroll
        data-limited={limited ? 'true' : undefined}
      >
        <table className={styles.table}>{children}</table>
      </div>
      {footer ? <div className={styles.tableFooter}>{footer}</div> : null}
    </section>
  )
}

function DirectionCozy() {
  return (
    <TableFrame
      title="发票列表"
      action={
        <WarmButton variant="secondary">
          导出
        </WarmButton>
      }
      footer={
        <>
          <span>共 {ORDERS.length} 条</span>
          <span>第 1 / 1 页</span>
        </>
      }
    >
      <thead>
        <tr>
          <th>发票号</th>
          <th>客户</th>
          <th>状态</th>
          <th className={styles.numeric}>金额</th>
          <th>方式</th>
        </tr>
      </thead>
      <tbody>
        {ORDERS.map((order) => (
          <tr key={order.id} className={styles.cozyRow}>
            <td className={styles.primaryCell}>{order.id}</td>
            <td>{order.customer}</td>
            <td>
              <StatusBadge status={order.status} label={order.statusLabel} />
            </td>
            <td className={styles.numeric}>{fmt(order.amount)}</td>
            <td className={styles.mutedCell}>{order.method}</td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  )
}

function BaselineDense() {
  const [sort, setSort] = React.useState<{ key: keyof Order; dir: 1 | -1 }>({
    key: 'date',
    dir: -1,
  })
  const [selected, setSelected] = React.useState<Set<string>>(new Set())

  const sorted = React.useMemo(
    () =>
      [...ORDERS].sort((a, b) => {
        const left = a[sort.key]
        const right = b[sort.key]
        if (typeof left === 'number' && typeof right === 'number') {
          return (left - right) * sort.dir
        }
        return String(left).localeCompare(String(right)) * sort.dir
      }),
    [sort]
  )

  const toggleSort = (key: keyof Order) =>
    setSort((current) =>
      current.key === key
        ? { key, dir: (current.dir * -1) as 1 | -1 }
        : { key, dir: 1 }
    )

  const SortHead = ({
    column,
    label,
    align,
  }: {
    column: keyof Order
    label: string
    align?: 'right'
  }) => (
    <th className={align === 'right' ? styles.numeric : undefined}>
      <button type="button" className={styles.sortButton} onClick={() => toggleSort(column)}>
        {label}
        {sort.key === column ? (
          sort.dir === 1 ? (
            <ChevronUp aria-hidden="true" />
          ) : (
            <ChevronDown aria-hidden="true" />
          )
        ) : (
          <ArrowUpDown aria-hidden="true" />
        )}
      </button>
    </th>
  )

  const allSelected = selected.size === sorted.length

  return (
    <TableFrame
      title="发票列表"
      limited
      toolbar={
        <>
          <label className={styles.searchField}>
            <Search aria-hidden="true" />
            <input placeholder="筛选发票或客户..." aria-label="筛选发票或客户" />
          </label>
          <span className={styles.selectionCount}>已选 {selected.size} / {sorted.length}</span>
        </>
      }
      footer={
        <>
          <span>第 1 / 1 页</span>
          <div className={styles.footerActions}>
            <WarmButton variant="quiet" disabled>
              上一页
            </WarmButton>
            <WarmButton variant="quiet" disabled>
              下一页
            </WarmButton>
          </div>
        </>
      }
    >
      <thead>
        <tr>
          <th className={styles.checkboxCell}>
            <input
              type="checkbox"
              aria-label="选择全部发票"
              checked={allSelected}
              onChange={(event) =>
                setSelected(event.target.checked ? new Set(sorted.map((order) => order.id)) : new Set())
              }
            />
          </th>
          <SortHead column="id" label="发票号" />
          <SortHead column="customer" label="客户" />
          <SortHead column="status" label="状态" />
          <SortHead column="amount" label="金额" align="right" />
          <SortHead column="date" label="日期" align="right" />
        </tr>
      </thead>
      <tbody>
        {sorted.map((order) => {
          const isSelected = selected.has(order.id)
          return (
            <tr key={order.id} data-state={isSelected ? 'selected' : undefined}>
              <td className={styles.checkboxCell}>
                <input
                  type="checkbox"
                  aria-label={`选择 ${order.id}`}
                  checked={isSelected}
                  onChange={() =>
                    setSelected((current) => {
                      const next = new Set(current)
                      if (next.has(order.id)) next.delete(order.id)
                      else next.add(order.id)
                      return next
                    })
                  }
                />
              </td>
              <td className={styles.primaryCell}>{order.id}</td>
              <td>{order.customer}</td>
              <td>
                <StatusBadge status={order.status} label={order.statusLabel} />
              </td>
              <td className={styles.numeric}>{fmt(order.amount)}</td>
              <td className={`${styles.numeric} ${styles.mutedCell}`}>{order.date}</td>
            </tr>
          )
        })}
      </tbody>
    </TableFrame>
  )
}

function DirectionMotion() {
  const [open, setOpen] = React.useState<string | null>(ORDERS[0].id)

  return (
    <TableFrame
      title="发票列表"
      limited
      action={
        <WarmButton variant="primary">
          新建发票
        </WarmButton>
      }
    >
      <thead>
        <tr>
          <th className={styles.toggleCell} aria-label="展开明细" />
          <th>发票号</th>
          <th>客户</th>
          <th>状态</th>
          <th className={styles.numeric}>金额</th>
          <th className={styles.numeric}>操作</th>
        </tr>
      </thead>
      <tbody>
        {ORDERS.map((order) => {
          const isOpen = open === order.id
          return (
            <React.Fragment key={order.id}>
              <tr
                className={styles.expandableRow}
                data-open={isOpen ? 'true' : 'false'}
                onClick={() => setOpen(isOpen ? null : order.id)}
              >
                <td className={styles.toggleCell}>
                  <ChevronRight
                    className={styles.expandIcon}
                    data-open={isOpen ? 'true' : 'false'}
                    aria-hidden="true"
                  />
                </td>
                <td className={styles.primaryCell}>{order.id}</td>
                <td>{order.customer}</td>
                <td>
                  <StatusBadge status={order.status} label={order.statusLabel} />
                </td>
                <td className={styles.numeric}>{fmt(order.amount)}</td>
                <td className={styles.numeric}>
                  <WarmButton
                    variant="quiet"
                    onClick={(event) => event.stopPropagation()}
                  >
                    查看
                  </WarmButton>
                </td>
              </tr>
              {isOpen ? (
                <tr className={styles.detailRow}>
                  <td colSpan={6}>
                    <div className={styles.detailGrid}>
                      <div>
                        <span className={styles.detailLabel}>明细数</span>
                        <span>{order.detail.items} 项</span>
                      </div>
                      <div>
                        <span className={styles.detailLabel}>区域</span>
                        <span>{order.detail.region}</span>
                      </div>
                      <div className={styles.detailNote}>
                        <span className={styles.detailLabel}>备注</span>
                        <span>{order.detail.note}</span>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : null}
            </React.Fragment>
          )
        })}
      </tbody>
    </TableFrame>
  )
}

const SPEC_ROWS: { item: string; rule: string }[] = [
  { item: '密度档位', rule: 'compact（默认，数据密集）/ cozy（宽松，展示型），行高与留白由页面 CSS Module 控制' },
  { item: '表头规则', rule: '低对比标签文字 + Warm panel-strong 底，表头滚动时保持可见' },
  { item: '数字列对齐', rule: '右对齐 + tabular-nums；金额、数量、比率使用 Warm mono' },
  { item: '状态色', rule: 'Warm semantic badge：positive / accent / negative / neutral' },
  { item: 'Sticky 行为', rule: '表头 sticky top；表格自身横向与纵向滚动，页面不横溢' },
  { item: '空状态', rule: '表格 colSpan 空态沿用页面真实字段与操作，不展示装饰占位' },
  { item: '桌面布局', rule: '1440×900 下保留完整操作列；长表在卡片内部滚动' },
]

function SpecQuickReference() {
  return (
    <TableFrame title="表格规范速览">
      <thead>
        <tr>
          <th className={styles.specNameCell}>规则项</th>
          <th>约定</th>
        </tr>
      </thead>
      <tbody>
        {SPEC_ROWS.map((row) => (
          <tr key={row.item}>
            <td className={styles.primaryCell}>{row.item}</td>
            <td className={styles.mutedCell}>{row.rule}</td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  )
}

const DIFF_ROWS: { dim: string; baseline: string; cozy: string; motion: string }[] = [
  { dim: '定位', baseline: '全站默认基线', cozy: '展示型列表变体', motion: '动效增强变体（可选）' },
  { dim: '密度', baseline: 'compact', cozy: 'cozy', motion: 'cozy' },
  { dim: '排序', baseline: '支持（点击表头）', cozy: '—', motion: '—' },
  { dim: '多选', baseline: '支持', cozy: '—', motion: '—' },
  { dim: 'Sticky 表头', baseline: '支持', cozy: '—', motion: '支持' },
  { dim: '行展开', baseline: '—', cozy: '—', motion: '支持（动效）' },
  { dim: '入场动效', baseline: '克制的行反馈', cozy: '无', motion: '行展开 + 方向旋转' },
  { dim: '适用场景', baseline: '数据密集型列表（财务/库存/报表）', cozy: '常规列表、低密度展示', motion: '需要交互反馈的列表' },
]

function DirectionDiffTable() {
  return (
    <TableFrame title="方向差异表">
      <thead>
        <tr>
          <th className={styles.diffNameCell}>维度</th>
          <th>基线 · 高密度数据网格（默认）</th>
          <th>变体 A · 宽松密度</th>
          <th>变体 C · 动效增强</th>
        </tr>
      </thead>
      <tbody>
        {DIFF_ROWS.map((row) => (
          <tr key={row.dim}>
            <td className={styles.primaryCell}>{row.dim}</td>
            <td>{row.baseline}</td>
            <td className={styles.mutedCell}>{row.cozy}</td>
            <td className={styles.mutedCell}>{row.motion}</td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  )
}

export default function TableShowcasePage() {
  return (
    <div className={styles.page} data-warm-page="table-showcase">
      <header className={styles.header}>
        <h1 className={styles.pageTitle}>Table 设计统一 · Showcase</h1>
        <p className={styles.lead}>
          全站表格共享同一套密度、数字对齐与状态契约；以下方向使用同一份 mock 数据。
        </p>
      </header>

      <section className={styles.showcaseSection}>
        <div className={styles.sectionHeading}>
          <WarmBadge tone="accent">spec</WarmBadge>
          <h2 className={styles.sectionTitle}>规范速览</h2>
        </div>
        <SpecQuickReference />
      </section>

      <section className={styles.showcaseSection}>
        <div className={styles.sectionHeading}>
          <WarmBadge tone="positive">baseline</WarmBadge>
          <h2 className={styles.sectionTitle}>基线 · 高密度数据网格（全站默认）</h2>
        </div>
        <BaselineDense />
      </section>

      <section className={styles.showcaseSection}>
        <div className={styles.sectionHeading}>
          <WarmBadge tone="neutral">variants</WarmBadge>
          <h2 className={styles.sectionTitle}>变体（按场景选型）</h2>
        </div>

        <div className={styles.variantBlock}>
          <div className={styles.variantHeading}>
            <WarmBadge tone="neutral">variant A</WarmBadge>
            <h3 className={styles.variantTitle}>宽松密度（cozy）· 展示型</h3>
          </div>
          <DirectionCozy />
        </div>

        <div className={styles.variantBlock}>
          <div className={styles.variantHeading}>
            <WarmBadge tone="neutral">variant C</WarmBadge>
            <h3 className={styles.variantTitle}>动效增强（行展开）· 占位</h3>
          </div>
          <DirectionMotion />
        </div>
      </section>

      <section className={styles.showcaseSection}>
        <div className={styles.sectionHeading}>
          <WarmBadge tone="accent">matrix</WarmBadge>
          <h2 className={styles.sectionTitle}>方向差异表</h2>
        </div>
        <DirectionDiffTable />
      </section>
    </div>
  )
}
