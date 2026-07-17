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

// ── 共享 mock 数据（三个方向用同一份，保证可比） ──
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

const ROW_BASE =
  'transition-colors hover:bg-[hsl(var(--surface-subtle))] data-[state=selected]:bg-primary/8'

// ============================================================
// Direction A — shadcn-minimal（克制统一）
// ============================================================
function DirectionMinimal() {
  return (
    <DataTableFrame
      title="发票列表"
      description="shadcn-minimal · 克制统一，零动效"
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
// Direction B — tablecn-dense（高密度数据网格 + 排序 + 选择）
// ============================================================
function DirectionDense() {
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
      className={cn(densityHead.compact, align === 'right' && 'text-right', 'cursor-pointer select-none hover:text-foreground')}
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
      description="tablecn-dense · 紧凑网格 + 排序 + 多选"
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
// Direction C — 21st.dev 风格（动效 + 状态色 + 行展开）· 参考占位
// 你带具体 21st.dev 链接来，我据此精修视觉。
// ============================================================
function DirectionMotion() {
  const [open, setOpen] = React.useState<string | null>(ORDERS[0].id)

  return (
    <DataTableFrame
      title="发票列表"
      description="21st.dev-style · 行展开动效 + 状态色 + sticky"
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
                    isOpen && 'bg-[hsl(var(--surface-subtle))]'
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
                      className="bg-[hsl(var(--surface-subtle))/0.5]"
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
// Showcase 页
// ============================================================
const DIRECTIONS: { id: string; name: string; desc: string; tag: string; node: React.ReactNode }[] = [
  { id: 'A', name: 'Direction A · shadcn-minimal', desc: '克制统一，零动效。作为"基线"——所有表都长这样，但不惊艳。', tag: 'baseline', node: <DirectionMinimal /> },
  { id: 'B', name: 'Direction B · tablecn-dense', desc: '高密度数据网格：紧凑间距 + 点击排序 + 多选 + sticky 表头 + 入场微动效。适合数据量大的列表。', tag: 'data-grid', node: <DirectionDense /> },
  { id: 'C', name: 'Direction C · 21st.dev 风格（参考占位）', desc: '动效 + 状态色 + 行展开。带具体 21st.dev 链接来我据此精修。', tag: 'motion', node: <DirectionMotion /> },
]

export default function TableShowcasePage() {
  return (
    <div className="dashboard-page-shell mx-auto w-full max-w-6xl space-y-10 px-4 py-8 md:px-6">
      <header className="space-y-3">
        <div className="dashboard-kicker">Design System · Table</div>
        <h1 className="dashboard-display">Table 设计统一 · Showcase</h1>
        <p className="max-w-2xl text-muted-foreground">
          三个方向共享同一份 mock 数据、同一套设计 token（{'`--surface-subtle`'} / {'`--border`'} / dark 玻璃边 / {'`--data-*`'} 状态色），
          仅视觉语言不同。右上角切换主题可看 dark 效果。带 21st.dev 链接来可对齐精修 Direction C，或新增方向。
        </p>
      </header>

      <div className="space-y-12">
        {DIRECTIONS.map((d) => (
          <section key={d.id} className="space-y-4">
            <div className="flex items-baseline gap-3 border-b border-border/60 pb-2">
              <span className="rounded-md bg-[hsl(var(--primary)/0.12)] px-2 py-0.5 text-xs font-semibold text-[hsl(var(--primary))]">
                {d.tag}
              </span>
              <h2 className="text-lg font-semibold tracking-tight">{d.name}</h2>
            </div>
            <p className="max-w-3xl text-sm text-muted-foreground">{d.desc}</p>
            <div className="animate-fade-slide-up">{d.node}</div>
          </section>
        ))}
      </div>
    </div>
  )
}
