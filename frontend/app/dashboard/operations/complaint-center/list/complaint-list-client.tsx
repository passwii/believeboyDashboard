'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownAz,
  ArrowUpZa,
  ClipboardCopy,
  Clock,
  Eye,
  Mail,
  MailWarning,
  MessageSquare,
  Trash2,
  XCircle,
} from 'lucide-react'
import { useSearchParams } from 'next/navigation'

import { WarmButton, WarmSelect } from '@/components/dashboard-v2/warm-ledger/controls'
import { parseDateInputValue } from '@/components/ui/date-picker'
import { MobileFilterStrip, MobileFilterWide } from '@/components/terminal/mobile-filter-strip'
import {
  useHeaderRefresh,
  useHeaderSlot,
  useMobileFilterStrip,
} from '@/components/terminal/terminal-header-slot'
import { useNotifications } from '@/components/notifications'
import {
  type ComplaintCategory,
  type ComplaintListResponse,
  type ComplaintStatus,
  type ComplaintSummaryItem,
  fetchComplaintList,
} from '@/lib/complaint-api'
import { useManagedProjects } from '@/lib/hooks/use-managed-projects'
import { ComplaintDetailDrawer } from './components/complaint-detail-drawer'
import styles from './complaint-list-warm.module.css'

const PAGE_SIZE = 20
const ALL_FILTER = 'all'

const STATUS_LABEL: Record<ComplaintStatus, string> = {
  pending: '待回复',
  drafted: '已起草',
  replied: '已回复',
  resolved: '已解决',
  closed_no_response: '关闭无回复',
}

const STATUS_ICON: Record<ComplaintStatus, typeof Mail> = {
  pending: Mail,
  drafted: Mail,
  replied: Mail,
  resolved: MailWarning,
  closed_no_response: XCircle,
}

const STATUS_TONE: Record<
  ComplaintStatus,
  'accent' | 'positive' | 'negative' | 'muted'
> = {
  pending: 'accent',
  drafted: 'muted',
  replied: 'accent',
  resolved: 'positive',
  closed_no_response: 'negative',
}

const CATEGORY_LABEL: Record<ComplaintCategory | '', string> = {
  with_order: '有订单',
  no_order_info: '无订单',
  spam: '垃圾',
  '': '全部分类',
}

const SLA_TONE: Record<
  ComplaintSummaryItem['sla_level'],
  'positive' | 'accent' | 'negative' | 'muted'
> = {
  ok: 'positive',
  soon: 'accent',
  overdue: 'negative',
  closed: 'muted',
}

function getDayStart(d: Date | undefined): Date {
  const r = new Date(d ?? new Date())
  r.setHours(0, 0, 0, 0)
  return r
}

function toYmdLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

type SpamCountScope = {
  date?: string
  project_id?: number
  country?: string
}

export default function ComplaintListClient() {
  const { notify } = useNotifications()
  const searchParams = useSearchParams()
  const { projects } = useManagedProjects()
  const [date, setDate] = useState<Date | null>(null)
  const [firstMessageDate, setFirstMessageDate] = useState<Date | null>(() => {
    const value = searchParams.get('first_message_date')
    return parseDateInputValue(value) ?? null
  })
  const [projectId, setProjectId] = useState(searchParams.get('project_id') ?? '')
  const [category, setCategory] = useState<ComplaintCategory | ''>(
    (searchParams.get('category') as ComplaintCategory) ?? ''
  )
  const [status, setStatus] = useState<ComplaintStatus | ''>(
    (searchParams.get('status') as ComplaintStatus) ?? ''
  )
  const [country, setCountry] = useState(searchParams.get('country') ?? '')
  const [keyword, setKeyword] = useState(searchParams.get('keyword') ?? '')
  const [sort, setSort] = useState<'sla_asc' | 'sla_desc' | 'date_asc' | 'date_desc'>(
    (searchParams.get('sort') as 'sla_asc' | 'sla_desc' | 'date_asc' | 'date_desc') ?? 'date_desc'
  )
  const [page, setPage] = useState(1)
  const [data, setData] = useState<ComplaintListResponse | null>(null)
  const [spamCountScope, setSpamCountScope] = useState<SpamCountScope | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const filters = useMemo(
    () => ({
      ...(date ? { date: toYmdLocal(date) } : {}),
      first_message_date: firstMessageDate ? toYmdLocal(firstMessageDate) : undefined,
      project_id: projectId ? Number(projectId) : undefined,
      category: category || undefined,
      status: status || undefined,
      country: country || undefined,
      keyword: keyword || undefined,
      sort,
      page,
      page_size: PAGE_SIZE,
    }),
    [date, firstMessageDate, projectId, category, status, country, keyword, sort, page]
  )

  const projectNameById = useMemo(() => {
    const map = new Map<number, string>()
    for (const project of projects) map.set(project.id, project.name)
    return map
  }, [projects])

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const result = await fetchComplaintList(filters, projectNameById)
      setData(result)
      setSpamCountScope({
        date: filters.date,
        project_id: filters.project_id,
        country: filters.country,
      })
    } catch (err) {
      notify({
        type: 'error',
        title: '加载失败',
        message: `加载明细失败: ${(err as Error).message}`,
      })
    } finally {
      setLoading(false)
    }
  }, [filters, projectNameById, notify])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const handleRefreshRef = useRef(loadData)
  handleRefreshRef.current = loadData
  useHeaderRefresh(() => handleRefreshRef.current(), { loading })

  const handleCopyOrder = useCallback(
    (orderId: string) => {
      if (typeof navigator === 'undefined' || !navigator.clipboard) return
      navigator.clipboard
        .writeText(orderId)
        .then(() => {
          notify({ type: 'success', title: '已复制', message: `已复制订单号 ${orderId}` })
        })
        .catch(() => {
          notify({ type: 'error', title: '复制失败' })
        })
    },
    [notify]
  )

  const handleRowClick = useCallback((id: number) => {
    setSelectedId(id)
  }, [])

  const handleInspectionDateChange = useCallback((next?: Date | null) => {
    setPage(1)
    setDate(next ? getDayStart(next) : null)
  }, [])

  const handleAllInspectionDates = useCallback(() => {
    setPage(1)
    setDate(null)
  }, [])

  const handleStatusChanged = useCallback(() => {
    setSelectedId(null)
    void loadData()
  }, [loadData])

  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE))
  const spamCountScopeIsCurrent =
    spamCountScope !== null &&
    spamCountScope.date === filters.date &&
    spamCountScope.project_id === filters.project_id &&
    spamCountScope.country === filters.country

  const headerControls = (
    <div
      className={styles.headerFilters}
      data-testid="complaint-list-header-filters"
      data-warm-header-filters="true"
    >
      <div className={styles.headerField}>
        <input
          type="date"
          value={date ? toYmdLocal(date) : ''}
          onChange={(event) => {
            const parsed = parseDateInputValue(event.target.value)
            handleInspectionDateChange(parsed)
          }}
          className={styles.headerDateInput}
          aria-label="巡检日期"
        />
        <WarmButton
          variant={date ? 'quiet' : 'secondary'}
          className={styles.headerButton}
          aria-pressed={!date}
          onClick={handleAllInspectionDates}
        >
          全部日期
        </WarmButton>
      </div>
      <input
        type="date"
        value={firstMessageDate ? toYmdLocal(firstMessageDate) : ''}
        onChange={(event) => {
          const parsed = parseDateInputValue(event.target.value)
          setPage(1)
          setFirstMessageDate(parsed ? getDayStart(parsed) : null)
        }}
        className={styles.headerDateInput}
        aria-label="首次咨询日期"
      />
      <WarmSelect
        id="complaint-list-status-filter"
        label="状态"
        value={status || ALL_FILTER}
        onChange={(value) => {
          setPage(1)
          setStatus(value === ALL_FILTER ? '' : (value as ComplaintStatus))
        }}
        options={[
          { value: ALL_FILTER, label: '全部状态' },
          { value: 'pending', label: '待回复' },
          { value: 'drafted', label: '已起草' },
          { value: 'replied', label: '已回复' },
          { value: 'resolved', label: '已解决' },
          { value: 'closed_no_response', label: '关闭无回复' },
        ]}
        placeholder="状态"
        className={styles.headerSelect}
      />
      <WarmSelect
        id="complaint-list-category-filter"
        label="分类"
        value={category || ALL_FILTER}
        onChange={(value) => {
          setPage(1)
          setCategory(value === ALL_FILTER ? '' : (value as ComplaintCategory))
        }}
        options={[
          { value: ALL_FILTER, label: '全部分类' },
          { value: 'with_order', label: '有订单' },
          { value: 'no_order_info', label: '无订单' },
          { value: 'spam', label: '垃圾' },
        ]}
        placeholder="分类"
        className={styles.headerSelect}
      />
      <input
        type="search"
        value={keyword}
        onChange={(event) => {
          setPage(1)
          setKeyword(event.target.value)
        }}
        placeholder="搜索买家/主题"
        className={styles.headerInput}
        aria-label="搜索买家或主题"
      />
    </div>
  )

  const desktopSlot = useHeaderSlot(headerControls)

  const mobileSummary = `${country} · ${status ? STATUS_LABEL[status] : '全部'} · ${
    CATEGORY_LABEL[category] ?? '全部'
  }`
  const mobileControls = (
    <>
      <div className={styles.mobileDateRow}>
        <input
          type="date"
          value={date ? toYmdLocal(date) : ''}
          onChange={(event) => {
            const parsed = parseDateInputValue(event.target.value)
            handleInspectionDateChange(parsed)
          }}
          className={`${styles.headerDateInput} ${styles.mobileDateInput}`}
          aria-label="巡检日期"
        />
        <WarmButton
          variant={date ? 'quiet' : 'secondary'}
          className={styles.headerButton}
          aria-pressed={!date}
          onClick={handleAllInspectionDates}
        >
          全部日期
        </WarmButton>
      </div>
      <input
        type="date"
        value={firstMessageDate ? toYmdLocal(firstMessageDate) : ''}
        onChange={(event) => {
          const parsed = parseDateInputValue(event.target.value)
          setPage(1)
          setFirstMessageDate(parsed ? getDayStart(parsed) : null)
        }}
        className={`${styles.headerDateInput} ${styles.mobileDateInput}`}
        aria-label="首次咨询日期"
      />
      <WarmSelect
        id="complaint-list-mobile-status-filter"
        label="状态"
        value={status || ALL_FILTER}
        onChange={(value) => {
          setPage(1)
          setStatus(value === ALL_FILTER ? '' : (value as ComplaintStatus))
        }}
        options={[
          { value: ALL_FILTER, label: '全部状态' },
          { value: 'pending', label: '待回复' },
          { value: 'drafted', label: '已起草' },
          { value: 'replied', label: '已回复' },
          { value: 'resolved', label: '已解决' },
          { value: 'closed_no_response', label: '关闭无回复' },
        ]}
        placeholder="状态"
        className={styles.mobileSelect}
      />
      <WarmSelect
        id="complaint-list-mobile-category-filter"
        label="分类"
        value={category || ALL_FILTER}
        onChange={(value) => {
          setPage(1)
          setCategory(value === ALL_FILTER ? '' : (value as ComplaintCategory))
        }}
        options={[
          { value: ALL_FILTER, label: '全部分类' },
          { value: 'with_order', label: '有订单' },
          { value: 'no_order_info', label: '无订单' },
          { value: 'spam', label: '垃圾' },
        ]}
        placeholder="分类"
        className={styles.mobileSelect}
      />
      <MobileFilterWide>
        <input
          type="search"
          value={keyword}
          onChange={(event) => {
            setPage(1)
            setKeyword(event.target.value)
          }}
          placeholder="搜索买家/主题"
          className={`${styles.headerInput} ${styles.mobileInput}`}
          aria-label="搜索买家或主题"
        />
      </MobileFilterWide>
    </>
  )
  const mobileStrip = useMobileFilterStrip(
    <MobileFilterStrip summary={mobileSummary} controls={mobileControls} />
  )

  return (
    <>
      {desktopSlot}
      {mobileStrip}
      <div
        className={styles.page}
        data-testid="complaint-list-page"
        data-warm-complaint-list="true"
      >
        {data && spamCountScopeIsCurrent && data.spam_count > 0 && (
          <div className={styles.notice} role="status">
            <Trash2 size={14} aria-hidden="true" />
            <span>
              {date ? `${toYmdLocal(date)} 标记垃圾` : '全部日期标记垃圾'}{' '}
              <span className={styles.noticeCount}>{data.spam_count}</span> 条
            </span>
            <WarmButton
              variant="quiet"
              className={styles.noticeAction}
              onClick={() => {
                setPage(1)
                setCategory('spam')
              }}
            >
              <Eye size={14} aria-hidden="true" />
              查看
            </WarmButton>
          </div>
        )}

        <section className={styles.panel} data-warm-panel="true">
          <header className={styles.panelHeader}>
            <div className={styles.panelHeading}>
              <h2 className={styles.panelTitle}>客诉列表</h2>
              {data ? <p className={styles.panelDescription}>共 {data.total} 条</p> : null}
            </div>
            <div className={styles.sortActions}>
              <WarmButton
                variant={sort.startsWith('date_') ? 'secondary' : 'quiet'}
                className={styles.textButton}
                aria-label={`按最近消息${sort === 'date_asc' ? '正序' : '倒序'}排序`}
                aria-pressed={sort.startsWith('date_')}
                onClick={() => setSort((current) => (current === 'date_desc' ? 'date_asc' : 'date_desc'))}
              >
                {sort === 'date_asc' ? (
                  <ArrowDownAz size={14} aria-hidden="true" />
                ) : (
                  <ArrowUpZa size={14} aria-hidden="true" />
                )}
                最近消息
              </WarmButton>
              <WarmButton
                variant={sort.startsWith('sla_') ? 'secondary' : 'quiet'}
                className={styles.textButton}
                aria-label={`按 SLA ${sort === 'sla_desc' ? '降序' : '升序'}排序`}
                aria-pressed={sort.startsWith('sla_')}
                onClick={() => setSort((current) => (current === 'sla_asc' ? 'sla_desc' : 'sla_asc'))}
              >
                {sort === 'sla_desc' ? (
                  <ArrowUpZa size={14} aria-hidden="true" />
                ) : (
                  <ArrowDownAz size={14} aria-hidden="true" />
                )}
                SLA
              </WarmButton>
            </div>
          </header>

          {loading ? (
            <div className={styles.loadingRows} role="status" aria-busy="true">
              <span className={styles.panelDescription}>正在加载客诉明细</span>
              {Array.from({ length: 5 }, (_, index) => (
                <div className={styles.loadingRow} key={index} aria-hidden="true" />
              ))}
            </div>
          ) : data && data.items.length > 0 ? (
            <>
              <div
                className={styles.mobileList}
                data-mobile-complaint-list="true"
                role="list"
                aria-label="客诉消息"
              >
                {data.items.map((item) => {
                  const StatusIcon = STATUS_ICON[item.status]
                  return (
                    <article className={styles.mobileCard} key={`mobile-${item.id}`} role="listitem">
                      <header className={styles.mobileCardHeader}>
                        <div className={styles.mobileProjectLine}>
                          <span className={styles.mobileProjectName}>{item.project_name}</span>
                          <span className={styles.mobileCountry}>{item.country}</span>
                        </div>
                        <span className={styles.categoryBadge}>{item.category_badge}</span>
                      </header>
                      <div className={styles.mobileSignals}>
                        <span className={styles.statusPill} data-tone={STATUS_TONE[item.status]}>
                          <StatusIcon size={12} aria-hidden="true" />
                          {STATUS_LABEL[item.status]}
                        </span>
                        <span className={styles.sla} data-tone={SLA_TONE[item.sla_level]}>
                          <Clock size={12} aria-hidden="true" />
                          {item.sla_remaining}
                        </span>
                      </div>
                      <button
                        type="button"
                        className={styles.mobileMessage}
                        onClick={() => handleRowClick(item.id)}
                        aria-label={`查看 ${item.buyer_name} 的消息详情：${item.subject}`}
                      >
                        <span className={styles.mobileMessageMeta}>
                          <span className={styles.buyerName}>{item.buyer_name}</span>
                          <span className={styles.meta}>{item.message_date}</span>
                        </span>
                        <span className={styles.mobileSubject} title={item.subject}>
                          {item.subject}
                        </span>
                        <span className={styles.mobileOpenLabel}>
                          <Eye size={14} aria-hidden="true" />
                          查看详情
                        </span>
                      </button>
                      <dl className={styles.mobileRecordDetails}>
                        <div>
                          <dt>关联订单</dt>
                          <dd>
                            {item.has_order ? '有' : '无'}
                            {item.order_id ? (
                              <>
                                <code>{item.order_id}</code>
                                <button
                                  type="button"
                                  className={styles.mobileCopyButton}
                                  onClick={() => handleCopyOrder(item.order_id!)}
                                  aria-label={`复制订单号 ${item.order_id}`}
                                >
                                  <ClipboardCopy size={15} aria-hidden="true" />
                                </button>
                              </>
                            ) : null}
                          </dd>
                        </div>
                        <div>
                          <dt>ASIN</dt>
                          <dd>{item.asin || '—'}</dd>
                        </div>
                        <div className={styles.mobileProduct}>
                          <dt>商品</dt>
                          <dd>{item.product_title || '—'}</dd>
                        </div>
                      </dl>
                    </article>
                  )
                })}
              </div>
              <div className={styles.tableScroll} data-warm-table-scroll="true">
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>店铺</th>
                      <th>买家</th>
                      <th>主题</th>
                      <th>分类</th>
                      <th>状态</th>
                      <th>SLA</th>
                      <th className={styles.actionsCell}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item) => {
                      const StatusIcon = STATUS_ICON[item.status]
                      return (
                        <tr
                          key={item.id}
                          className={styles.tableRow}
                          tabIndex={0}
                          onClick={() => handleRowClick(item.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              handleRowClick(item.id)
                            }
                          }}
                        >
                          <td className={styles.projectName}>{item.project_name}</td>
                          <td>
                            <span className={styles.buyerName}>{item.buyer_name}</span>
                            <span className={styles.meta}>{item.message_date}</span>
                          </td>
                          <td className={styles.subjectCell}>
                            <div className={styles.subjectLine}>
                              <span className={styles.subject} title={item.subject}>
                                {item.subject}
                              </span>
                              {item.order_id ? (
                                <button
                                  type="button"
                                  className={styles.copyButton}
                                  onClick={(event) => {
                                    event.stopPropagation()
                                    handleCopyOrder(item.order_id!)
                                  }}
                                  title="复制订单号"
                                  aria-label={`复制订单号 ${item.order_id}`}
                                >
                                  <ClipboardCopy size={12} aria-hidden="true" />
                                </button>
                              ) : null}
                            </div>
                            {item.order_id ? (
                              <span className={styles.meta}>{item.order_id}</span>
                            ) : null}
                          </td>
                          <td>
                            <span className={styles.categoryBadge}>{item.category_badge}</span>
                          </td>
                          <td>
                            <span className={styles.statusPill} data-tone={STATUS_TONE[item.status]}>
                              <StatusIcon size={11} aria-hidden="true" />
                              {STATUS_LABEL[item.status]}
                            </span>
                          </td>
                          <td>
                            <span className={styles.sla} data-tone={SLA_TONE[item.sla_level]}>
                              <Clock size={11} aria-hidden="true" /> {item.sla_remaining}
                            </span>
                          </td>
                          <td className={styles.actionsCell}>
                            <WarmButton
                              variant="quiet"
                              className={styles.textButton}
                              onClick={(event) => {
                                event.stopPropagation()
                                handleRowClick(item.id)
                              }}
                            >
                              <Eye size={14} aria-hidden="true" />
                              详情
                            </WarmButton>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 ? (
                <div className={styles.pagination}>
                  <span className={styles.paginationMeta}>
                    第 {page}/{totalPages} 页 · {data.total} 条
                  </span>
                  <div className={styles.paginationControls}>
                    <WarmButton
                      variant="quiet"
                      className={styles.textButton}
                      aria-label="上一页"
                      disabled={page <= 1}
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                    >
                      上一页
                    </WarmButton>
                    {Array.from({ length: totalPages }, (_, index) => index + 1).map(
                      (pageNumber) => (
                        <WarmButton
                          key={pageNumber}
                          variant={pageNumber === page ? 'secondary' : 'quiet'}
                          className={styles.numberButton}
                          data-active={pageNumber === page}
                          aria-label={`第 ${pageNumber} 页`}
                          aria-current={pageNumber === page ? 'page' : undefined}
                          onClick={() => setPage(pageNumber)}
                        >
                          {pageNumber}
                        </WarmButton>
                      )
                    )}
                    <WarmButton
                      variant="quiet"
                      className={styles.textButton}
                      aria-label="下一页"
                      disabled={page >= totalPages}
                      onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                    >
                      下一页
                    </WarmButton>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className={styles.empty} role="status">
              暂无客诉数据
            </div>
          )}
        </section>

        {selectedId !== null ? (
          <ComplaintDetailDrawer
            complaintId={selectedId}
            open={selectedId !== null}
            onClose={() => setSelectedId(null)}
            onStatusChanged={handleStatusChanged}
            projectNameById={projectNameById}
          />
        ) : null}
      </div>
    </>
  )
}
