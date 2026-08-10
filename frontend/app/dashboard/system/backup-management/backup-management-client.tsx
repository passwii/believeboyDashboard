'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DataCard,
  DataCardContent,
  DataCardHeader,
  DataTableCard,
  DataTableCardBody,
  DataTableCardHeader,
} from '@/components/ui/data-card'
import { EmptyTableState } from '@/components/ui/empty-state'
import { StatusPill, type TableStatus } from '@/components/ui/table-presets'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Loader2,
  Database,
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Shield,
  Info,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/components/notifications'
import { useConfirm } from '@/hooks/use-confirm'

const API_BASE = '/api/backend'

type BackupStatus = 'pending' | 'running' | 'completed' | 'failed'
type BackupType = 'full' | 'differential' | 'wal_archive'

type BackupRecord = {
  id: number
  backup_type: string
  status: BackupStatus
  phase: string
  triggered_by: string
  retry_count: number
  backup_set_name: string | null
  r2_key: string | null
  r2_url: string | null
  r2_bucket: string | null
  r2_uploaded_at: string | null
  r2_deleted_at: string | null
  compressed_size_bytes: number | null
  started_at: string
  completed_at: string | null
  size_bytes: number | null
  duration_seconds: number | null
  error_message: string | null
  backup_info: string | null
  created_by: number | null
  created_at: string
}

type BackupStatusSummary = {
  last_backup: BackupRecord | null
  total_backups: number
  successful_backups: number
  failed_backups: number
  is_backup_running: boolean
}

type BackupInfo = {
  raw_info: string
  backups: Array<{
    archive: Array<{ active: boolean; date: string; id: string }>
    backup: Array<{
      info: {
        database: { delta: number; size: number }
        database_size: number
        last_xlog: string
        timestamp: { start: string; stop: string }
      }
      size: number
      timestamp: string
      type: string
    }>
  }>
}

const STATUS_COLORS: Record<BackupStatus, TableStatus> = {
  pending: 'neutral',
  running: 'info',
  completed: 'success',
  failed: 'negative',
}

const STATUS_LABELS: Record<BackupStatus, string> = {
  pending: '等待中',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
}

const TYPE_LABELS: Record<string, string> = {
  full: '全量备份',
  differential: '增量备份',
  wal_archive: 'WAL 归档',
}

const PHASE_LABELS: Record<string, string> = {
  pending: '排队中',
  pgbackrest_running: '执行 pgBackRest',
  compressing: '打包中',
  r2_uploading: '上传 R2',
  completed: '完成',
  failed: '失败',
}

const PHASE_BAR_COLORS: Record<string, string> = {
  pending: 'bg-slate-400',
  pgbackrest_running: 'bg-blue-500',
  compressing: 'bg-purple-500',
  r2_uploading: 'bg-cyan-500',
  completed: 'bg-emerald-500',
  failed: 'bg-red-500',
}

const PHASE_PROGRESS: Record<string, number> = {
  pending: 10,
  pgbackrest_running: 40,
  compressing: 65,
  r2_uploading: 85,
  completed: 100,
  failed: 100,
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '-'
  if (seconds < 60) return `${seconds} 秒`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (mins < 60) return `${mins} 分 ${secs} 秒`
  const hours = Math.floor(mins / 60)
  const remainingMins = mins % 60
  return `${hours} 小时 ${remainingMins} 分`
}

function formatDatetime(datetimeStr: string | null): string {
  if (!datetimeStr) return '-'
  const date = new Date(datetimeStr)
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function BackupRecordDetail({
  record,
  onDownload,
  onRestore,
  onDelete,
}: {
  record: BackupRecord
  onDownload: (r: BackupRecord) => void
  onRestore: (r: BackupRecord) => void
  onDelete: (r: BackupRecord) => void
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-4 text-sm">
        <div>
          <p className="text-muted-foreground">R2 Key</p>
          <p className="font-mono text-xs break-all">{record.r2_key || '-'}</p>
        </div>
        <div>
          <p className="text-muted-foreground">R2 Bucket</p>
          <p className="font-medium">{record.r2_bucket || '-'}</p>
        </div>
        <div>
          <p className="text-muted-foreground">压缩后大小</p>
          <p className="font-medium">{formatBytes(record.compressed_size_bytes)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">上传时间</p>
          <p className="font-medium">{formatDatetime(record.r2_uploaded_at)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">备份集</p>
          <p className="font-mono text-xs">{record.backup_set_name || '-'}</p>
        </div>
        <div>
          <p className="text-muted-foreground">重试次数</p>
          <p className="font-medium">{record.retry_count}</p>
        </div>
        <div>
          <p className="text-muted-foreground">已从 R2 删除</p>
          <p className="font-medium">{record.r2_deleted_at ? formatDatetime(record.r2_deleted_at) : '否'}</p>
        </div>
      </div>
      {record.error_message && (
        <div className="rounded-md border border-[hsl(var(--data-negative)/0.3)] bg-[hsl(var(--data-negative)/0.08)] p-2 text-sm text-[hsl(var(--data-negative))]">
          {record.error_message}
        </div>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!record.r2_key || !!record.r2_deleted_at}
          onClick={(e) => {
            e.stopPropagation()
            onDownload(record)
          }}
        >
          下载
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!record.backup_set_name}
          onClick={(e) => {
            e.stopPropagation()
            onRestore(record)
          }}
        >
          恢复命令
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={(e) => {
            e.stopPropagation()
            onDelete(record)
          }}
        >
          删除
        </Button>
      </div>
    </div>
  )
}

export function BackupManagementClient() {
  const { data: session } = useSession()
  const { notify } = useNotifications()
  const { confirm } = useConfirm()
  const [records, setRecords] = useState<BackupRecord[]>([])
  const [statusSummary, setStatusSummary] = useState<BackupStatusSummary | null>(null)
  const [backupInfo, setBackupInfo] = useState<BackupInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [triggering, setTriggering] = useState(false)
  const [showTriggerDialog, setShowTriggerDialog] = useState(false)
  const [selectedType, setSelectedType] = useState<BackupType>('full')
  const [activeTab, setActiveTab] = useState('records')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [restoreCommand, setRestoreCommand] = useState<string | null>(null)
  const [showRestoreDialog, setShowRestoreDialog] = useState(false)

  const loadData = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true)
    try {
      const [statusRes, recordsRes] = await Promise.all([
        fetch(`${API_BASE}/api/v1/backups/status`),
        fetch(`${API_BASE}/api/v1/backups/records?limit=50`),
      ])

      if (statusRes.ok) {
        setStatusSummary(await statusRes.json())
      }

      if (recordsRes.ok) {
        const data = await recordsRes.json()
        setRecords(data.items || [])
      }
    } catch (e) {
      console.error('Failed to load backup data:', e)
    } finally {
      if (showSpinner) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  // 3s 轮询：存在 pending / running 记录时才启动，全部终态后停止
  const hasActiveBackup = records.some((r) => r.status === 'pending' || r.status === 'running')
  useEffect(() => {
    if (!hasActiveBackup) return
    const timer = setInterval(() => void loadData(false), 3000)
    return () => clearInterval(timer)
  }, [hasActiveBackup, loadData])

  const handleTriggerBackup = async () => {
    setTriggering(true)
    try {
      const res = await fetch(`${API_BASE}/api/v1/backups/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backup_type: selectedType }),
      })

      const data = await res.json()

      if (res.ok) {
        setRecords((prev) => [{ ...data, ...data }, ...prev])
        setShowTriggerDialog(false)
        // Refresh status
        const statusRes = await fetch(`${API_BASE}/api/v1/backups/status`)
        if (statusRes.ok) {
          setStatusSummary(await statusRes.json())
        }
      } else {
        notify({ type: 'error', title: `备份启动失败: ${data.detail || '未知错误'}` })
      }
    } catch (e) {
      console.error('Failed to trigger backup:', e)
      notify({ type: 'error', title: '备份启动失败' })
    } finally {
      setTriggering(false)
    }
  }

  const handleVerifyBackups = async () => {
    const confirmed = await confirm({ title: '确定要验证所有备份吗？', variant: 'destructive' })
    if (!confirmed) return
    try {
      const res = await fetch(`${API_BASE}/api/v1/backups/verify`, { method: 'POST' })
      const data = await res.json()
      notify({ type: 'success', title: data.message || '验证完成' })
    } catch (e) {
      notify({ type: 'error', title: '验证失败' })
    }
  }

  const handleDownload = async (record: BackupRecord) => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/backups/${record.id}/download-url`)
      if (!res.ok) throw new Error('download url failed')
      const { url } = await res.json()
      window.open(url, '_blank')
    } catch {
      notify({ type: 'error', title: '获取下载链接失败' })
    }
  }

  const handleRestoreCommand = async (record: BackupRecord) => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/backups/${record.id}/restore-command`)
      if (!res.ok) throw new Error('restore command failed')
      const { command } = await res.json()
      setRestoreCommand(command)
      setShowRestoreDialog(true)
    } catch {
      notify({ type: 'error', title: '生成恢复命令失败' })
    }
  }

  const handleDeleteBackup = async (record: BackupRecord) => {
    const confirmed = await confirm({
      title: `确定删除备份 #${record.id}？将同时删除 R2 上的备份文件`,
      variant: 'destructive',
    })
    if (!confirmed) return
    try {
      const res = await fetch(`${API_BASE}/api/v1/backups/${record.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('delete failed')
      notify({ type: 'success', title: '备份已删除' })
      void loadData(false)
    } catch {
      notify({ type: 'error', title: '删除失败' })
    }
  }

  const loadBackupInfo = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/v1/backups/info`)
      if (res.ok) {
        setBackupInfo(await res.json())
      }
    } catch (e) {
      console.error('Failed to load backup info:', e)
    }
  }

  useEffect(() => {
    if (activeTab === 'info') {
      void loadBackupInfo()
    }
  }, [activeTab])

  return (
    <div className="w-full space-y-6">
      {/* ── 页面头部：eyebrow pill + 标题 + 描述 + 操作区（BLF-505：收口为 PageHeader 原语 §8.1） ── */}
      <PageHeader
        eyebrow={
          <>
            <Shield className="h-3.5 w-3.5" />
            系统管理 · 备份管理
          </>
        }
        title="备份管理"
        description="PostgreSQL 数据库定时备份到 Cloudflare R2，支持全量 / 增量 / WAL 归档。"
        actions={
          <Button
            onClick={() => setShowTriggerDialog(true)}
            disabled={statusSummary?.is_backup_running}
          >
            <Database className="mr-2 h-4 w-4" />
            {statusSummary?.is_backup_running ? '备份进行中...' : '手动备份'}
          </Button>
        }
      />

      {/* ── 备份概览 KPI（surface token 图标块 + dashboard-panel 瓦片） ── */}
      <DataCard>
        <DataCardHeader title="备份概览" description="备份任务累计与当前执行状态" />
        <DataCardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="dashboard-panel flex items-center gap-3">
              <div className="rounded-lg bg-[hsl(var(--primary)/0.12)] p-2 text-[hsl(var(--primary))]">
                <Database className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="text-2xl font-semibold tabular-nums leading-tight">
                  {statusSummary?.total_backups ?? '-'}
                </p>
                <p className="truncate text-sm text-muted-foreground">总备份数</p>
              </div>
            </div>

            <div className="dashboard-panel flex items-center gap-3">
              <div className="rounded-lg bg-[hsl(var(--data-positive)/0.12)] p-2 text-[hsl(var(--data-positive))]">
                <CheckCircle className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="text-2xl font-semibold tabular-nums leading-tight">
                  {statusSummary?.successful_backups ?? '-'}
                </p>
                <p className="truncate text-sm text-muted-foreground">成功</p>
              </div>
            </div>

            <div className="dashboard-panel flex items-center gap-3">
              <div className="rounded-lg bg-[hsl(var(--data-negative)/0.12)] p-2 text-[hsl(var(--data-negative))]">
                <XCircle className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="text-2xl font-semibold tabular-nums leading-tight">
                  {statusSummary?.failed_backups ?? '-'}
                </p>
                <p className="truncate text-sm text-muted-foreground">失败</p>
              </div>
            </div>

            <div className="dashboard-panel flex items-center gap-3">
              <div
                className={cn(
                  'rounded-lg p-2',
                  statusSummary?.is_backup_running
                    ? 'bg-[hsl(var(--primary)/0.12)] text-[hsl(var(--primary))]'
                    : 'bg-[hsl(var(--data-neutral)/0.12)] text-[hsl(var(--data-neutral))]'
                )}
              >
                <RefreshCw
                  className={cn(
                    'h-5 w-5',
                    statusSummary?.is_backup_running && 'animate-spin'
                  )}
                />
              </div>
              <div className="min-w-0">
                <p className="text-2xl font-semibold tabular-nums leading-tight">
                  {statusSummary?.is_backup_running ? '进行中' : '空闲'}
                </p>
                <p className="truncate text-sm text-muted-foreground">当前状态</p>
              </div>
            </div>
          </div>
        </DataCardContent>
      </DataCard>

      {/* ── 最近备份 ── */}
      {statusSummary?.last_backup && (
        <DataCard>
          <DataTableCardHeader>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-base font-semibold leading-none text-foreground">最近备份</h2>
            </div>
          </DataTableCardHeader>
          <DataCardContent>
            <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
              <div>
                <p className="text-muted-foreground">备份类型</p>
                <p className="font-medium">
                  {TYPE_LABELS[statusSummary.last_backup.backup_type]}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">状态</p>
                <StatusPill
                  status={STATUS_COLORS[statusSummary.last_backup.status as BackupStatus]}
                  label={STATUS_LABELS[statusSummary.last_backup.status as BackupStatus]}
                />
              </div>
              <div>
                <p className="text-muted-foreground">备份时间</p>
                <p className="font-medium">
                  {formatDatetime(statusSummary.last_backup.started_at)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">大小</p>
                <p className="font-medium">
                  {formatBytes(statusSummary.last_backup.size_bytes)}
                </p>
              </div>
            </div>
          </DataCardContent>
        </DataCard>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <TabsList className="w-full justify-start rounded-2xl border border-border/70 bg-muted/25 p-1 dark:border-border/80 dark:bg-[hsl(var(--surface-soft))] sm:w-auto">
            <TabsTrigger value="records" className="min-h-10 px-5 py-2 text-sm">
              📋 备份记录
            </TabsTrigger>
            <TabsTrigger value="info" className="min-h-10 px-5 py-2 text-sm">
              🔍 pgBackRest 信息
            </TabsTrigger>
          </TabsList>
          <Button size="sm" variant="outline" onClick={handleVerifyBackups}>
            <Shield className="mr-1 h-4 w-4" />
            验证备份
          </Button>
        </div>

        <TabsContent value="records">
          <DataTableCard>
            <DataTableCardHeader
              title="备份记录"
              description="最近 50 条备份记录，含阶段进度与 R2 归档状态"
            />
            <DataTableCardBody>
              {loading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <>
                  {/* 桌面端：完整表格（MOBILE_ADAPTATION_RULES 规则 1） */}
                  <div className="hidden md:block">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[64px]">ID</TableHead>
                          <TableHead>类型</TableHead>
                          <TableHead>状态</TableHead>
                          <TableHead>开始时间</TableHead>
                          <TableHead>完成时间</TableHead>
                          <TableHead>大小</TableHead>
                          <TableHead>耗时</TableHead>
                          <TableHead>触发</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {records.map((record) => (
                          <Fragment key={record.id}>
                            <TableRow
                              className="cursor-pointer"
                              onClick={() =>
                                setExpandedId(expandedId === record.id ? null : record.id)
                              }
                            >
                              <TableCell className="text-muted-foreground">#{record.id}</TableCell>
                              <TableCell>
                                <Badge variant="outline">
                                  {TYPE_LABELS[record.backup_type] || record.backup_type}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <div className="space-y-1">
                                  <StatusPill
                                    status={STATUS_COLORS[record.status as BackupStatus]}
                                    label={STATUS_LABELS[record.status as BackupStatus]}
                                  />
                                  {(record.status === 'pending' || record.status === 'running') && (
                                    <div className="flex items-center gap-2">
                                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                                        <div
                                          className={cn(
                                            'h-full rounded-full transition-all duration-500',
                                            PHASE_BAR_COLORS[record.phase] || 'bg-slate-400'
                                          )}
                                          style={{
                                            width: `${PHASE_PROGRESS[record.phase] ?? 10}%`,
                                          }}
                                        />
                                      </div>
                                      <span className="text-xs text-muted-foreground">
                                        {PHASE_LABELS[record.phase] || record.phase}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell>{formatDatetime(record.started_at)}</TableCell>
                              <TableCell>{formatDatetime(record.completed_at)}</TableCell>
                              <TableCell className="tabular-nums">
                                {formatBytes(record.size_bytes)}
                              </TableCell>
                              <TableCell className="tabular-nums">
                                {formatDuration(record.duration_seconds)}
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline">
                                  {record.triggered_by === 'auto' ? '自动' : '手动'}
                                </Badge>
                              </TableCell>
                            </TableRow>
                            {expandedId === record.id && (
                              <TableRow className="bg-muted/30">
                                <TableCell colSpan={8} className="px-6 py-4">
                                  <BackupRecordDetail
                                    record={record}
                                    onDownload={handleDownload}
                                    onRestore={handleRestoreCommand}
                                    onDelete={handleDeleteBackup}
                                  />
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        ))}
                        {records.length === 0 && (
                          <EmptyTableState colSpan={8} message="暂无备份记录" />
                        )}
                      </TableBody>
                    </Table>
                  </div>

                  {/* 手机端：卡片列表（规则 1） */}
                  <div className="md:hidden space-y-3 p-4">
                    {records.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-12 text-center">
                        <Database className="mb-4 h-12 w-12 text-muted-foreground/50" />
                        <p className="mb-2 text-muted-foreground">暂无备份记录</p>
                        <p className="text-sm text-muted-foreground/70">
                          点击「手动备份」创建第一个备份，或等待每天凌晨 3:00 的自动备份
                        </p>
                      </div>
                    ) : (
                      records.map((record) => (
                        <div key={record.id} className="dashboard-surface space-y-3 p-4">
                          <div className="flex items-start justify-between gap-2 border-b border-border/70 pb-3">
                            <div className="min-w-0">
                              <div className="font-semibold">
                                #{record.id} · {TYPE_LABELS[record.backup_type] || record.backup_type}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {formatDatetime(record.started_at)}
                              </div>
                            </div>
                            <StatusPill
                              status={STATUS_COLORS[record.status as BackupStatus]}
                              label={STATUS_LABELS[record.status as BackupStatus]}
                            />
                          </div>
                          {(record.status === 'pending' || record.status === 'running') && (
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-full max-w-[9rem] overflow-hidden rounded-full bg-muted">
                                <div
                                  className={cn(
                                    'h-full rounded-full transition-all duration-500',
                                    PHASE_BAR_COLORS[record.phase] || 'bg-slate-400'
                                  )}
                                  style={{ width: `${PHASE_PROGRESS[record.phase] ?? 10}%` }}
                                />
                              </div>
                              <span className="text-xs text-muted-foreground">
                                {PHASE_LABELS[record.phase] || record.phase}
                              </span>
                            </div>
                          )}
                          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                            <div>
                              <span className="text-xs text-muted-foreground">完成时间</span>
                              <div>{formatDatetime(record.completed_at)}</div>
                            </div>
                            <div>
                              <span className="text-xs text-muted-foreground">大小</span>
                              <div className="tabular-nums">{formatBytes(record.size_bytes)}</div>
                            </div>
                            <div>
                              <span className="text-xs text-muted-foreground">耗时</span>
                              <div className="tabular-nums">
                                {formatDuration(record.duration_seconds)}
                              </div>
                            </div>
                            <div>
                              <span className="text-xs text-muted-foreground">触发</span>
                              <div>{record.triggered_by === 'auto' ? '自动' : '手动'}</div>
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-9 min-h-[44px] w-full"
                            onClick={() =>
                              setExpandedId(expandedId === record.id ? null : record.id)
                            }
                          >
                            {expandedId === record.id ? '收起详情' : '查看详情'}
                          </Button>
                          {expandedId === record.id && (
                            <div className="border-t border-border/70 pt-3">
                              <BackupRecordDetail
                                record={record}
                                onDownload={handleDownload}
                                onRestore={handleRestoreCommand}
                                onDelete={handleDeleteBackup}
                              />
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}
            </DataTableCardBody>
          </DataTableCard>
        </TabsContent>

        <TabsContent value="info">
          {backupInfo ? (
            <DataCard>
              <DataTableCardHeader>
                <div className="flex items-center gap-2">
                  <Info className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-base font-semibold leading-none text-foreground">
                    pgBackRest 备份信息
                  </h2>
                </div>
              </DataTableCardHeader>
              <DataCardContent>
                <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-4 text-xs">
                  {JSON.stringify(backupInfo.backups, null, 2)}
                </pre>
              </DataCardContent>
            </DataCard>
          ) : (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Trigger Backup Dialog */}
      <Dialog open={showTriggerDialog} onOpenChange={setShowTriggerDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>手动备份</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">
              选择备份类型并开始新的备份。备份将存储到 Cloudflare R2。
            </p>
            <div className="space-y-2">
              <label className="text-sm font-medium">备份类型</label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant={selectedType === 'full' ? 'default' : 'outline'}
                  onClick={() => setSelectedType('full')}
                >
                  <Database className="mr-2 h-4 w-4" />
                  全量备份
                </Button>
                <Button
                  variant={selectedType === 'differential' ? 'default' : 'outline'}
                  onClick={() => setSelectedType('differential')}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  增量备份
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {selectedType === 'full'
                  ? '完整备份数据库，可能需要较长时间'
                  : '仅备份自上次备份以来的变更，速度更快'}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowTriggerDialog(false)}>
              取消
            </Button>
            <Button onClick={handleTriggerBackup} disabled={triggering}>
              {triggering ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  备份中...
                </>
              ) : (
                <>
                  <Database className="mr-2 h-4 w-4" />
                  开始备份
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Restore Command Preview Dialog */}
      <Dialog open={showRestoreDialog} onOpenChange={setShowRestoreDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>恢复命令预览</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex items-start gap-2 rounded-md border border-[hsl(var(--data-warning)/0.3)] bg-[hsl(var(--data-warning)/0.08)] p-3 text-sm text-[hsl(var(--data-warning))]">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>此操作会覆盖目标数据库，生产环境执行前请先在测试环境验证。命令仅供复制，本页不会执行。</span>
            </div>
            <pre className="text-xs bg-muted p-3 rounded-lg overflow-auto whitespace-pre-wrap break-all">
              {restoreCommand}
            </pre>
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(restoreCommand || '')
                notify({ type: 'success', title: '已复制到剪贴板' })
              }}
            >
              复制命令
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
