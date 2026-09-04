'use client'

import * as React from 'react'

import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUpDown, ChevronDown, ChevronRight, ChevronUp, Search } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  STICKY_TOP_ROW,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DataTableFrame,
  densityCell,
  densityHead,
  numericCell,
  numericHead,
  StatusPill,
  type TableStatus,
} from '@/components/ui/table-presets'
import { TermPill } from '@/components/terminal/term-controls'

// ── 共享 mock 数据（所有方向用同一份，保证可比） ──
type Order = {
  id: string
  customer: string
  status: TableStatus
  statusLabel: string
  amount: number
  method: string
  date: string
  detail: { items: number; region: string; note: string }
}

const ORDERS: Order[] = [
  { id: 'INV-2041', customer: 'Aurora Labs', status: 'success', statusLabel: '已回款', amount: 2480.5, method: '信用卡', date: '07-12', detail: { items: 12, region: 'US-East', note: '月付订阅，自动续费正常。' } },
  { id: 'INV-2042', customer: 'Nimbus Retail', status: 'warning', statusLabel: '待对账', amount: 1190.0, method: 'PayPal', date: '07-12', detail: { items: 5, region: 'EU-DE', note: '跨境手续费待核销。' } },
  { id: 'INV-2043', customer: 'Vertex Co', status: 'negative', statusLabel: '已退票', amount: 760.25, method: '银行转账', date: '07-11', detail: { items: 3, region: 'US-West', note: '账户余额不足，已发起二次扣款。' } },
  { id: 'INV-2044', customer: 'Lumen Goods', status: 'success', statusLabel: '已回款', amount: 3120.0, method: '信用卡', date: '07-11', detail: { items: 21, region: 'US-East', note: '大额订单，物流已发货。' } },
  { id: 'INV-2045', customer: 'Quill Studio', status: 'neutral', statusLabel: '草稿', amount: 0, method: '—', date: '07-10', detail: { items: 0, region: '—', note: '报价草稿，待客户确认。' } },
  { id: 'INV-2046', customer: 'Beacon Inc', status: 'success', statusLabel: '已回款', amount: 540.8, method: 'PayPal', date: '07-10', detail: { items: 2, region: 'EU-UK', note: '小额续费。' } },
  { id: 'INV-2047', customer: 'Cobalt Trade', status: 'warning', statusLabel: '待对账', amount: 1980.0, method: '银行转账', date: '07-09', detail: { items: 9, region: 'US-West', note: '对公转账在途。' } },
  { id: 'INV-2048', customer: 'Slate Goods', status: 'success', statusLabel: '已回款', amount: 870.4, method: '信用卡', date: '07-09', detail: { items: 6, region: 'US-East', note: '常规采购。' } },
]

const fmt = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const ROW_BASE = 'transition-colors hover:bg-term-hover data-[state=selected]:bg-term-raised'

// ============================================================
// 变体 A — 宽松密度（cozy）：常规列表/展示型表格用
// ============================================================
function DirectionCozy() {
  return (
    <DataTableFrame
      title="发票列表"
      description="变体 A · 宽松密度（cozy）· 克制统一，零动效"
      action={<Button variant="outline" size="sm">导出</Button>}
      footer={
        <>
          <span className="text-sm text-muted-foreground">共 {ORDERS.length} 条</span>
          <span className="text-sm text-muted-foreground">第 1 / 1 页</span>
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={densityHead.cozy}>发票号</TableHead>
            <TableHead className={densityHead.cozy}>客户</TableHead>
            <TableHead className={densityHead.cozy}>状态</TableHead>
            <TableHead className={cn(densityHead.cozy, numericHead)}>金额</TableHead>
            <TableHead className={densityHead.cozy}>方式</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ORDERS.map((o) => (
            <TableRow key={o.id} className={ROW_BASE}>
              <TableCell className={cn(densityCell.cozy, 'font-medium')}>{o.id}</TableCell>
              <TableCell className={densityCell.cozy}>{o.customer}</TableCell>
              <TableCell className={densityCell.cozy}>
                <StatusPill status={o.status} label={o.statusLabel} />
              </TableCell>
              <TableCell className={cn(densityCell.cozy, numericCell)}>{fmt(o.amount)}</TableCell>
              <TableCell className={cn(densityCell.cozy, 'text-muted-foreground')}>{o.method}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTableFrame>
  )
}

// ============================================================
// 基线 — 高密度数据网格（compact）：数据密集型列表的默认配方
// 全站默认：密度 compact + 排序 + 多选 + sticky 表头 + 数字列右对齐
// ============================================================
function BaselineDense() {
  const [sort, setSort] = React.useState<{ key: keyof Order; dir: 1 | -1 }>({
    key: 'date',
    dir: -1,
  })
  const [selected, setSelected] = React.useState<Set<string>>(new Set())

  const sorted = React.useMemo(() => {
    return [...ORDERS].sort((a, b) => {
      const av = a[sort.key]
      const bv = b[sort.key]
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sort.dir
      return String(av).localeCompare(String(bv)) * sort.dir
    })
  }, [sort])

  const toggleSort = (key: keyof Order) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }))

  const SortHead = ({ k, label, align }: { k: keyof Order; label: string; align?: string }) => (
    <TableHead
      className={cn(densityHead.compact, align === 'right' && 'text-right', 'cursor-pointer select-none hover:text-term-text')}
      onClick={() => toggleSort(k)}
    >
      <span className={cn('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
        {label}
        {sort.key === k ? (
          sort.dir === 1 ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </span>
    </TableHead>
  )

  const allSelected = selected.size === sorted.length

  return (
    <DataTableFrame
      title="发票列表"
      description="基线 · 高密度数据网格（compact）· 排序 + 多选 + sticky 表头"
      toolbar={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative max-w-xs">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="筛选发票或客户..." className="h-9 pl-9 shadow-none" />
          </div>
          <span className="text-sm text-muted-foreground">已选 {selected.size} / {sorted.length}</span>
        </div>
      }
      maxHeight={320}
      footer={
        <>
          <span className="text-sm text-muted-foreground">第 1 / 1 页</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled>上一页</Button>
            <Button variant="outline" size="sm" disabled>下一页</Button>
          </div>
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow className={STICKY_TOP_ROW}>
            <TableHead className={cn(densityHead.compact, 'w-10')}>
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                checked={allSelected}
                onChange={(e) =>
                  setSelected(e.target.checked ? new Set(sorted.map((o) => o.id)) : new Set())
                }
              />
            </TableHead>
            <SortHead k="id" label="发票号" />
            <SortHead k="customer" label="客户" />
            <SortHead k="status" label="状态" />
            <SortHead k="amount" label="金额" align="right" />
            <SortHead k="date" label="日期" align="right" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((o, i) => {
            const isSel = selected.has(o.id)
            return (
              <motion.tr
                key={o.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, delay: i * 0.03, ease: [0.16, 1, 0.3, 1] }}
                data-state={isSel ? 'selected' : undefined}
                className={ROW_BASE}
              >
                <TableCell className={densityCell.compact}>
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                    checked={isSel}
                    onChange={() =>
                      setSelected((s) => {
                        const n = new Set(s)
                        n.has(o.id) ? n.delete(o.id) : n.add(o.id)
                        return n
                      })
                    }
                  />
                </TableCell>
                <TableCell className={cn(densityCell.compact, 'font-medium')}>{o.id}</TableCell>
                <TableCell className={densityCell.compact}>{o.customer}</TableCell>
                <TableCell className={densityCell.compact}>
                  <StatusPill status={o.status} label={o.statusLabel} dot={false} />
                </TableCell>
                <TableCell className={cn(densityCell.compact, numericCell)}>{fmt(o.amount)}</TableCell>
                <TableCell className={cn(densityCell.compact, numericCell, 'text-muted-foreground')}>
                  {o.date}
                </TableCell>
              </motion.tr>
            )
          })}
        </TableBody>
      </Table>
    </DataTableFrame>
  )
}

// ============================================================
// 变体 C — 动效增强（行展开）· 可选增强，非默认
// 需用户提供具体 21st.dev 参考链接后再精修视觉。
// ============================================================
function DirectionMotion() {
  const [open, setOpen] = React.useState<string | null>(ORDERS[0].id)

  return (
    <DataTableFrame
      title="发票列表"
      description="变体 C · 动效增强（行展开）· 可选，需 21st.dev 参考精修"
      action={<Button size="sm">新建发票</Button>}
      maxHeight={360}
    >
      <Table>
        <TableHeader>
          <TableRow className={STICKY_TOP_ROW}>
            <TableHead className={cn(densityHead.cozy, 'w-10')} />
            <TableHead className={densityHead.cozy}>发票号</TableHead>
            <TableHead className={densityHead.cozy}>客户</TableHead>
            <TableHead className={densityHead.cozy}>状态</TableHead>
            <TableHead className={cn(densityHead.cozy, numericHead)}>金额</TableHead>
            <TableHead className={cn(densityHead.cozy, numericHead)}>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ORDERS.map((o) => {
            const isOpen = open === o.id
            return (
              <React.Fragment key={o.id}>
                <motion.tr
                  layout
                  onClick={() => setOpen(isOpen ? null : o.id)}
                  className={cn(
                    ROW_BASE,
                    'cursor-pointer',
                    isOpen && 'bg-term-hover'
                  )}
                >
                  <TableCell className={densityCell.cozy}>
                    <motion.span
                      animate={{ rotate: isOpen ? 90 : 0 }}
                      transition={{ duration: 0.2 }}
                      className="inline-flex text-muted-foreground"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </motion.span>
                  </TableCell>
                  <TableCell className={cn(densityCell.cozy, 'font-medium')}>{o.id}</TableCell>
                  <TableCell className={densityCell.cozy}>{o.customer}</TableCell>
                  <TableCell className={densityCell.cozy}>
                    <StatusPill status={o.status} label={o.statusLabel} />
                  </TableCell>
                  <TableCell className={cn(densityCell.cozy, numericCell)}>{fmt(o.amount)}</TableCell>
                  <TableCell className={cn(densityCell.cozy, numericCell)}>
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={(e) => e.stopPropagation()}>
                      查看
                    </Button>
                  </TableCell>
                </motion.tr>
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.tr
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="bg-term-raised"
                    >
                      <TableCell colSpan={6} className="!p-0">
                        <motion.div
                          initial={{ height: 0 }}
                          animate={{ height: 'auto' }}
                          exit={{ height: 0 }}
                          transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                          className="overflow-hidden"
                        >
                          <div className="grid grid-cols-2 gap-x-8 gap-y-2 px-6 py-4 text-sm md:grid-cols-4">
                            <div>
                              <div className="text-[0.66rem] uppercase tracking-[0.14em] text-muted-foreground">明细数</div>
                              <div className="font-medium">{o.detail.items} 项</div>
                            </div>
                            <div>
                              <div className="text-[0.66rem] uppercase tracking-[0.14em] text-muted-foreground">区域</div>
                              <div className="font-medium">{o.detail.region}</div>
                            </div>
                            <div className="col-span-2">
                              <div className="text-[0.66rem] uppercase tracking-[0.14em] text-muted-foreground">备注</div>
                              <div className="text-muted-foreground">{o.detail.note}</div>
                            </div>
                          </div>
                        </motion.div>
                      </TableCell>
                    </motion.tr>
                  )}
                </AnimatePresence>
              </React.Fragment>
            )
          })}
        </TableBody>
      </Table>
    </DataTableFrame>
  )
}

// ============================================================
// 规范速览（Spec Quick Reference）— 本页自身也用统一配方实现
// ============================================================
const SPEC_ROWS: { item: string; rule: string }[] = [
  { item: '密度档位', rule: 'compact（默认，数据密集）/ cozy（宽松，展示型）→ densityHead / densityCell' },
  { item: '表头规则', rule: 'uppercase + tracking-[0.14em] + term-raised 底；compact 档 text-[0.66rem]，cozy 档 text-[0.6875rem]' },
  { item: '数字列对齐', rule: '右对齐 + tabular-nums + font-medium → numericCell / numericHead（金额、数量、比率）' },
  { item: '状态色', rule: 'StatusPill（success / warning / negative / neutral / info），映射 --data-* token，自动适配 dark' },
  { item: 'Sticky 行为', rule: '表头 STICKY_TOP_ROW（z-40）；左列 STICKY_LEFT_HEAD_CELL（z-50）/ STICKY_LEFT_CELL（z-30），term 实体不透明背景' },
  { item: '空状态', rule: '表格空态 EmptyTableState（colSpan）；图表空态 EmptyChartState（height）' },
  { item: 'Mobile 降级', rule: '容器 overflow-x-auto 横向滚动；操作列保留；关键列可 sticky left-0' },
]

function SpecQuickReference() {
  return (
    <DataTableFrame
      title="表格规范速览"
      description="全站表格的唯一配方：DataTableCard / DataTableFrame 外壳 + table-presets 预设"
      maxHeight={360}
    >
      <Table>
        <TableHeader>
          <TableRow className={STICKY_TOP_ROW}>
            <TableHead className={cn(densityHead.compact, 'w-36')}>规则项</TableHead>
            <TableHead className={densityHead.compact}>约定</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {SPEC_ROWS.map((r) => (
            <TableRow key={r.item}>
              <TableCell className={cn(densityCell.compact, 'font-medium')}>{r.item}</TableCell>
              <TableCell className={cn(densityCell.compact, 'text-muted-foreground')}>{r.rule}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTableFrame>
  )
}

// ============================================================
// 方向差异表 — 基线 vs 变体（明确多方向定位，便于按场景选型）
// ============================================================
const DIFF_ROWS: { dim: string; baseline: string; cozy: string; motion: string }[] = [
  { dim: '定位', baseline: '全站默认基线', cozy: '展示型列表变体', motion: '动效增强变体（可选）' },
  { dim: '密度', baseline: 'compact（h-9 表头）', cozy: 'cozy（h-11 表头）', motion: 'cozy' },
  { dim: '排序', baseline: '支持（点击表头）', cozy: '—', motion: '—' },
  { dim: '多选', baseline: '支持', cozy: '—', motion: '—' },
  { dim: 'Sticky 表头', baseline: '支持', cozy: '—', motion: '支持' },
  { dim: '行展开', baseline: '—', cozy: '—', motion: '支持（动效）' },
  { dim: '入场动效', baseline: '极轻（0.25s 淡入）', cozy: '无', motion: '行展开 + 旋转' },
  { dim: '适用场景', baseline: '数据密集型列表（财务/库存/报表）', cozy: '常规列表、低密度展示', motion: '需要交互反馈的列表' },
]

function DirectionDiffTable() {
  return (
    <DataTableFrame
      title="方向差异表"
      description="基线（高密度数据网格）为全站默认；变体按场景选型，实现均走同一配方"
      maxHeight={360}
    >
      <Table>
        <TableHeader>
          <TableRow className={STICKY_TOP_ROW}>
            <TableHead className={cn(densityHead.compact, 'w-28')}>维度</TableHead>
            <TableHead className={densityHead.compact}>基线 · 高密度数据网格（默认）</TableHead>
            <TableHead className={densityHead.compact}>变体 A · 宽松密度</TableHead>
            <TableHead className={densityHead.compact}>变体 C · 动效增强</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {DIFF_ROWS.map((r) => (
            <TableRow key={r.dim}>
              <TableCell className={cn(densityCell.compact, 'font-medium')}>{r.dim}</TableCell>
              <TableCell className={cn(densityCell.compact, 'text-foreground')}>{r.baseline}</TableCell>
              <TableCell className={cn(densityCell.compact, 'text-muted-foreground')}>{r.cozy}</TableCell>
              <TableCell className={cn(densityCell.compact, 'text-muted-foreground')}>{r.motion}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DataTableFrame>
  )
}

// ============================================================
// Showcase 页 — 全站表格规范展示页
// ============================================================
export default function TableShowcasePage() {
  return (
    <div className="dashboard-page-shell mx-auto w-full max-w-6xl space-y-12 px-4 py-8 md:px-6">
      <header className="space-y-3">
        <div className="dashboard-kicker">Design System · Table</div>
        <h1 className="dashboard-display">Table 设计统一 · Showcase</h1>
        <p className="max-w-2xl text-muted-foreground">
          表格是全站最高频组件，已定稿为<b className="font-semibold text-foreground">单一配方</b>：
          <code className="border border-term-border bg-term-raised px-1.5 py-0.5 font-mono text-[0.8em] text-term-text">
            DataTableCard / DataTableFrame
          </code>
          外壳 +{' '}
          <code className="border border-term-border bg-term-raised px-1.5 py-0.5 font-mono text-[0.8em] text-term-text">
            table-presets
          </code>
          的 density / numeric / StatusPill 预设。以下展示基线（默认）与两个变体的实际效果，
          全部共享同一份 mock 数据与同一套设计 token，右上角切换主题可看 dark 效果。
          规范文档见 <code className="border border-term-border bg-term-raised px-1.5 py-0.5 font-mono text-[0.8em] text-term-text">frontend/docs/table-spec.md</code>。
        </p>
      </header>

      {/* 规范速览 */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3 border-b border-term-border pb-2">
          <TermPill tone="accent">spec</TermPill>
          <h2 className="text-lg font-semibold tracking-tight">规范速览</h2>
        </div>
        <div className="animate-fade-slide-up">
          <SpecQuickReference />
        </div>
      </section>

      {/* 基线 */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3 border-b border-term-border pb-2">
          <TermPill tone="pos">baseline</TermPill>
          <h2 className="text-lg font-semibold tracking-tight">基线 · 高密度数据网格（全站默认）</h2>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          数据密集型列表（财务、库存、报表、佣金）的默认配方：compact 密度 + 点击排序 +
          多选 + sticky 表头 + 数字列右对齐 + 状态徽章。所有新表格优先按此实现。
        </p>
        <div className="animate-fade-slide-up">
          <BaselineDense />
        </div>
      </section>

      {/* 变体 */}
      <section className="space-y-12">
        <div className="flex items-baseline gap-3 border-b border-term-border pb-2">
          <TermPill tone="muted">variants</TermPill>
          <h2 className="text-lg font-semibold tracking-tight">变体（按场景选型）</h2>
        </div>
        <p className="-mt-6 max-w-3xl text-sm text-muted-foreground">
          变体仅调整密度 / 交互层，底层仍是同一套配方。需要动效增强时，
          请提供具体 21st.dev 参考链接，据此精修变体 C 的视觉。
        </p>

        <div className="space-y-4">
          <div className="flex items-baseline gap-3 border-b border-term-border pb-2">
            <TermPill tone="muted">variant A</TermPill>
            <h3 className="text-base font-semibold tracking-tight">宽松密度（cozy）· 展示型</h3>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">
            常规列表 / 低密度展示：cozy 档位（h-11 表头），零动效，克制统一。
          </p>
          <div className="animate-fade-slide-up">
            <DirectionCozy />
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-baseline gap-3 border-b border-term-border pb-2">
            <TermPill tone="muted">variant C</TermPill>
            <h3 className="text-base font-semibold tracking-tight">动效增强（行展开）· 占位</h3>
          </div>
          <p className="max-w-3xl text-sm text-muted-foreground">
            动效 + 状态色 + 行展开。带具体 21st.dev 链接来可据此精修视觉；未提供前保持占位，不作为默认。
          </p>
          <div className="animate-fade-slide-up">
            <DirectionMotion />
          </div>
        </div>
      </section>

      {/* 方向差异表 */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3 border-b border-term-border pb-2">
          <TermPill tone="accent">matrix</TermPill>
          <h2 className="text-lg font-semibold tracking-tight">方向差异表</h2>
        </div>
        <div className="animate-fade-slide-up">
          <DirectionDiffTable />
        </div>
      </section>
    </div>
  )
}
