'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, History, RefreshCcw, ShieldAlert } from 'lucide-react'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import { AUDIT_ACTION_LABELS } from '@/lib/crm/types'
import type { AuditAction, AuditLog } from '@/lib/crm/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ACTION_BADGE } from '@/components/crm/crm-audit-timeline'

/** 实体类型 → 中文标签（筛选用）。 */
const ENTITY_LABELS: Record<string, string> = {
  customer: '客户',
  lead: '线索',
  contact: '联系人',
  task: '任务',
}

/** 筛选「全部」的 Radix Select 哨兵值（Radix 不允许空字符串 value）。 */
const ALL = 'all'
const PAGE_SIZE = 30

/**
 * CRM 操作日志页（P4 审计日志，仅管理员）。
 *
 * 可见性：sidebar 不做角色墙（roles 已移除），权限由后端 require_admin 兜底——
 * 非管理员调用 listAuditLogs 返回 403，本页优雅展示「无权限」而非报错。
 * 数据拉取沿用本仓库 useEffect + useState 范式（项目未引入 react-query）。
 */
export default function CrmAuditPage() {
  const client = useCrmClient()
  const [entityType, setEntityType] = useState<string>(ALL)
  const [action, setAction] = useState<string>(ALL)
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<AuditLog[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setForbidden(false)
    try {
      const res = await client.listAuditLogs({
        entityType: entityType === ALL ? undefined : entityType,
        action: action === ALL ? undefined : action,
        page,
        pageSize: PAGE_SIZE,
      })
      setItems(res.items)
      setTotal(res.total)
    } catch {
      // 后端 require_admin 对非管理员返回 403 → 展示「无权限」
      setForbidden(true)
    } finally {
      setLoading(false)
    }
  }, [client, entityType, action, page])

  useEffect(() => {
    void load()
  }, [load])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-4 p-4 md:p-6">
      {/* 页头 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <History className="h-5 w-5 text-muted-foreground" />
            操作日志
          </h1>
          <p className="text-sm text-muted-foreground">
            客户 / 线索 / 联系人的全部操作留痕（仅管理员可见）
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          <RefreshCcw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          刷新
        </button>
      </div>

      {/* 无权限（403）：非管理员访问时的兜底展示 */}
      {forbidden ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-6 py-12 text-center">
          <ShieldAlert className="h-8 w-8 text-amber-600 dark:text-amber-400" />
          <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
            无权限查看操作日志（仅管理员）
          </p>
        </div>
      ) : (
        <>
          {/* 筛选 + 总数 */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">对象</span>
              <Select
                value={entityType}
                onValueChange={(v) => {
                  setEntityType(v)
                  setPage(1)
                }}
              >
                <SelectTrigger className="h-8 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>全部对象</SelectItem>
                  {Object.entries(ENTITY_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">操作</span>
              <Select
                value={action}
                onValueChange={(v) => {
                  setAction(v)
                  setPage(1)
                }}
              >
                <SelectTrigger className="h-8 w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>全部操作</SelectItem>
                  {Object.entries(AUDIT_ACTION_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!loading && (
              <span className="ml-auto text-xs text-muted-foreground">共 {total} 条记录</span>
            )}
          </div>

          {/* 日志表格 */}
          <Card>
            <CardContent className="pt-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[150px]">时间</TableHead>
                    <TableHead className="w-[110px]">对象</TableHead>
                    <TableHead className="w-[110px]">操作</TableHead>
                    <TableHead className="w-[110px]">操作人</TableHead>
                    <TableHead>变更</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    Array.from({ length: 6 }).map((_, i) => (
                      <TableRow key={i}>
                        <TableCell colSpan={5} className="py-3">
                          <Skeleton className="h-5 w-full" />
                        </TableCell>
                      </TableRow>
                    ))
                  ) : items.length === 0 ? (
                    <EmptyState colSpan={5} icon="file" message="暂无操作记录" />
                  ) : (
                    items.map((log) => (
                      <TableRow key={log.id} className="transition-colors hover:bg-muted/40">
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {new Date(log.createdAt).toLocaleString('zh-CN')}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {ENTITY_LABELS[log.entityType] ?? log.entityType}
                          <span className="ml-1 text-xs text-muted-foreground/70">
                            #{log.entityId}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={`font-normal ${ACTION_BADGE[log.action as AuditAction] ?? ''}`}
                          >
                            {AUDIT_ACTION_LABELS[log.action as AuditAction] ?? log.action}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {log.actorName ?? '系统'}
                        </TableCell>
                        <TableCell className="max-w-[360px] text-muted-foreground">
                          <span className="line-clamp-2">{log.summary ?? '-'}</span>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* 分页 */}
          <div className="flex items-center justify-end gap-2 text-sm">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
              上一页
            </Button>
            <span className="px-1 text-muted-foreground">
              第 {page} / {totalPages} 页
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
