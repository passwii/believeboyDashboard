'use client'

import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import {
  ArrowDownAz,
  ArrowUpZa,
  CheckCircle2,
  ChevronDown,
  ClipboardCopy,
  Clock,
  Eye,
  Filter,
  Loader2,
  Mail,
  MailWarning,
  MessageSquare,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react'
import { useSearchParams } from 'next/navigation'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyTableState } from '@/components/ui/empty-state'
import { FilterToolbar } from '@/components/ui/filter-toolbar'
import { Input } from '@/components/ui/input'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination'
import { PageHeader } from '@/components/ui/page-header'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DataTableCard, DataTableCardHeader, DataTableCardBody } from '@/components/ui/data-card'
import { SimpleDatePicker } from '@/components/ui/date-picker'
import { useNotifications } from '@/components/notifications'
import { useHeaderRefresh } from '@/components/terminal/terminal-header-slot'
import {
  type ComplaintSummaryItem,
  type ComplaintStatus,
  type ComplaintCategory,
  type ComplaintListResponse,
  fetchComplaintList,
} from '@/lib/complaint-api'
import { ComplaintDetailDrawer } from './components/complaint-detail-drawer'

const STATUS_LABEL: Record<ComplaintStatus, string> = {
  pending: '待回复',
  drafted: '已起草',
  replied: '已回复',
  resolved: '已解决',
  closed_no_response: '关闭无回复',
}

const STATUS_ICON: Record<ComplaintStatus, typeof Mail> = {
  pending: MailWarning,
  drafted: Pencil,
  replied: Mail,
  resolved: CheckCircle2,
  closed_no_response: XCircle,
}

const STATUS_STYLE: Record<ComplaintStatus, string> = {
  pending: 'border-term-border bg-term-raised text-term-text',
  drafted: 'border-term-warn/20 bg-term-warn/10 text-term-warn',
  replied: 'border-term-accent/20 bg-term-accent/10 text-term-accent',
  resolved: 'border-term-pos/20 bg-term-pos/10 text-term-pos',
  closed_no_response: 'border-term-border bg-term-raised text-term-muted',
}

const CATEGORY_LABEL: Record<ComplaintCategory | '', string> = {
  '': '全部分类',
  with_order: '有订单',
  no_order_info: '无订单',
  spam: '垃圾',
}

const CATEGORY_BADGE: Record<ComplaintCategory | '', 'info' | 'warning' | 'outline' | 'secondary'> = {
  '': 'outline',
  with_order: 'info',
  no_order_info: 'warning',
  spam: 'secondary',
}

const SLA_STYLE: Record<ComplaintSummaryItem['sla_level'], string> = {
  ok: 'text-term-text',
  soon: 'text-term-warn',
  overdue: 'text-term-neg',
  closed: 'text-term-muted',
}

const SLA_ICON: Record<ComplaintSummaryItem['sla_level'], typeof Clock> = {
  ok: Clock,
  soon: Clock,
  overdue: Clock,
  closed: Clock,
}

const PAGE_SIZE = 20

function getDayStart(d: Date | undefined): Date {
  const r = new Date(d ?? new Date())
  r.setHours(0, 0, 0, 0)
  return r
}

export default function ComplaintListClient() {
  const { notify } = useNotifications()
  const searchParams = useSearchParams()

  const [date, setDate] = useState<Date>(new Date())
  const [shopId, setShopId] = useState(searchParams.get('shop_id') ?? '')
  const [category, setCategory] = useState<ComplaintCategory | ''>(
    (searchParams.get('category') as ComplaintCategory) ?? ''
  )
  const [status, setStatus] = useState<ComplaintStatus | ''>(
    (searchParams.get('status') as ComplaintStatus) ?? ''
  )
  const [site, setSite] = useState(searchParams.get('site') ?? '')
  const [keyword, setKeyword] = useState(searchParams.get('keyword') ?? '')
  const [sort, setSort] = useState<'sla_asc' | 'sla_desc' | 'date_asc' | 'date_desc'>(
    (searchParams.get('sort') as 'sla_asc') ?? 'sla_asc'
  )
  const [page, setPage] = useState(1)
  const [data, setData] = useState<ComplaintListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const filters = useMemo(
    () => ({
      date: date.toISOString().slice(0, 10),
      shop_id: shopId || undefined,
      category: category || undefined,
      status: status || undefined,
      site: site || undefined,
      keyword: keyword || undefined,
      sort,
      page,
      page_size: PAGE_SIZE,
    }),
    [date, shopId, category, status, site, keyword, sort, page]
  )

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const result = await fetchComplaintList(filters)
      setData(result)
    } catch (err) {
      notify({ type: 'error', title: '加载失败', message: `加载明细失败: ${(err as Error).message}` })
    } finally {
      setLoading(false)
    }
  }, [filters, notify])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const handleRefreshRef = useRef(loadData)
  handleRefreshRef.current = loadData
  useHeaderRefresh(() => handleRefreshRef.current(), { loading })

  const handleCopyOrder = useCallback(
    (orderId: string) => {
      if (typeof navigator === 'undefined' || !navigator.clipboard) return
      navigator.clipboard.writeText(orderId).then(() => {
        notify({ type: 'success', title: '已复制', message: `已复制订单号 ${orderId}` })
      }).catch(() => {
        notify({ type: 'error', title: '复制失败' })
      })
    },
    [notify]
  )

  const handleRowClick = useCallback((id: number) => {
    setSelectedId(id)
  }, [])

  const handleStatusChanged = useCallback(() => {
    setSelectedId(null)
    void loadData()
  }, [loadData])

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE))

  return (
    <div className="w-full space-y-6">
      <PageHeader
        eyebrow={<><ShieldCheck size={14} /> 运营 · 客诉中心</>}
        title="客诉明细"
        description="筛选、排序、人工处理与状态流转。点击行查看详情。"
      />

      <FilterToolbar
        actions={
          <Button variant="term" size="sm" onClick={() => void loadData()} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            刷新
          </Button>
        }
      >
        <SimpleDatePicker
          value={date}
          onChange={(d) => {
            setPage(1)
            if (d) setDate(getDayStart(d))
          }}
          className="w-[130px]"
        />
        <Select
          value={status}
          onValueChange={(v) => {
            setPage(1)
            setStatus(v as ComplaintStatus | '')
          }}
        >
          <SelectTrigger className="w-[110px]">
            <SelectValue placeholder="状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部状态</SelectItem>
            <SelectItem value="pending">待回复</SelectItem>
            <SelectItem value="drafted">已起草</SelectItem>
            <SelectItem value="replied">已回复</SelectItem>
            <SelectItem value="resolved">已解决</SelectItem>
            <SelectItem value="closed_no_response">关闭无回复</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={category}
          onValueChange={(v) => {
            setPage(1)
            setCategory(v as ComplaintCategory | '')
          }}
        >
          <SelectTrigger className="w-[100px]">
            <SelectValue placeholder="分类" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部分类</SelectItem>
            <SelectItem value="with_order">有订单</SelectItem>
            <SelectItem value="no_order_info">无订单</SelectItem>
            <SelectItem value="spam">垃圾</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={keyword}
          onChange={(e) => {
            setPage(1)
            setKeyword(e.target.value)
          }}
          placeholder="搜索买家/主题"
          className="w-[160px]"
        />
      </FilterToolbar>

      {data && data.spam_count > 0 && (
        <div className="flex items-center gap-2 rounded-none border border-term-border bg-term-raised px-3 py-2 text-xs text-term-muted">
          <Trash2 size={12} />
          今日标记垃圾 <span className="font-semibold text-term-text">{data.spam_count}</span> 条
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto"
            onClick={() => {
              setPage(1)
              setCategory('spam')
            }}
          >
            <Eye size={12} />
            查看
          </Button>
        </div>
      )}

      <DataTableCard>
        <DataTableCardHeader
          title="客诉列表"
          description={data ? `共 ${data.total} 条` : undefined}
          action={
            <Button variant="ghost" size="xs" onClick={() => setSort((s) => (s === 'sla_asc' ? 'sla_desc' : 'sla_asc'))}>
              {sort === 'sla_asc' ? <ArrowDownAz size={12} /> : <ArrowUpZa size={12} />}
              SLA
            </Button>
          }
        />
        <DataTableCardBody>
          {loading ? (
            <div className="space-y-3 py-4">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex items-center gap-4 px-3">
                  <div className="h-4 w-20 bg-term-raised" />
                  <div className="h-4 flex-1 bg-term-raised" />
                  <div className="h-4 w-16 bg-term-raised" />
                  <div className="h-4 w-24 bg-term-raised" />
                </div>
              ))}
            </div>
          ) : data && data.items.length > 0 ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[140px]">店铺</TableHead>
                    <TableHead>买家</TableHead>
                    <TableHead className="w-[200px]">主题</TableHead>
                    <TableHead>分类</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>SLA</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((item) => {
                    const StatusIcon = STATUS_ICON[item.status]
                    return (
                      <TableRow
                        key={item.id}
                        onClick={() => handleRowClick(item.id)}
                        className="cursor-pointer hover:bg-term-hover/50"
                      >
                        <TableCell className="font-medium text-term-text">{item.shop_name}</TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="text-term-text">{item.buyer_name}</span>
                            <span className="text-xs text-term-muted">{item.message_date}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1 truncate text-sm">
                            <span className="truncate" title={item.subject}>
                              {item.subject}
                            </span>
                            {item.order_id && (
                              <button
                                type="button"
                                className="shrink-0 text-term-muted hover:text-term-text"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleCopyOrder(item.order_id!)
                                }}
                                title="复制订单号"
                              >
                                <ClipboardCopy size={11} />
                              </button>
                            )}
                          </div>
                          {item.order_id && (
                            <span className="font-mono text-[11px] text-term-muted">{item.order_id}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={CATEGORY_BADGE[item.category]} className="text-[11px]">
                            {item.category_badge}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center gap-1 rounded-none border px-1.5 py-0.5 text-[11px] font-semibold ${STATUS_STYLE[item.status]}`}
                          >
                            <StatusIcon size={10} />
                            {STATUS_LABEL[item.status]}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className={`font-mono text-xs ${SLA_STYLE[item.sla_level]}`}>
                            {item.sla_remaining}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleRowClick(item.id)
                            }}
                          >
                            <Eye size={12} />
                            详情
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              {totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-term-border px-3 py-2">
                  <span className="text-xs text-term-muted">
                    第 {page}/{totalPages} 页 · {data.total} 条
                  </span>
                  <Pagination className="mx-0 w-auto">
                    <PaginationContent>
                      <PaginationItem>
                        <PaginationPrevious
                          onClick={() => setPage((p) => Math.max(1, p - 1))}
                          className={page <= 1 ? 'pointer-events-none opacity-40' : 'cursor-pointer'}
                        />
                      </PaginationItem>
                      {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                        <PaginationItem key={p}>
                          <PaginationLink
                            isActive={p === page}
                            onClick={() => setPage(p)}
                            className="cursor-pointer"
                          >
                            {p}
                          </PaginationLink>
                        </PaginationItem>
                      ))}
                      <PaginationItem>
                        <PaginationNext
                          onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                          className={page >= totalPages ? 'pointer-events-none opacity-40' : 'cursor-pointer'}
                        />
                      </PaginationItem>
                    </PaginationContent>
                  </Pagination>
                </div>
              )}
            </>
          ) : (
            <EmptyTableState colSpan={7} message="暂无客诉数据" />
          )}
        </DataTableCardBody>
      </DataTableCard>

      {selectedId !== null && (
        <ComplaintDetailDrawer
          complaintId={selectedId}
          open={selectedId !== null}
          onClose={() => setSelectedId(null)}
          onStatusChanged={handleStatusChanged}
        />
      )}
    </div>
  )
}
