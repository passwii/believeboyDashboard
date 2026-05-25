'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Loader2, Database, Clock, CheckCircle, XCircle, AlertTriangle, RefreshCw, Shield, Info } from 'lucide-react'
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

const STATUS_COLORS: Record<BackupStatus, string> = {
  pending: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
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

  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      try {
        const [statusRes, recordsRes] = await Promise.all([
          fetch(`${API_BASE}/api/v1/backups/status`),
          fetch(`${API_BASE}/api/v1/backups/records?limit=50`),
        ])

        if (statusRes.ok) {
          const data = await statusRes.json()
          setStatusSummary(data)
        }

        if (recordsRes.ok) {
          const data = await recordsRes.json()
          setRecords(data.items || [])
        }
      } catch (e) {
        console.error('Failed to load backup data:', e)
      } finally {
        setLoading(false)
      }
    }
    void loadData()
  }, [])

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
        setRecords(prev => [{ ...data, ...data }, ...prev])
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">备份管理</h1>
          <p className="text-sm text-muted-foreground mt-1">PostgreSQL 数据库备份到 Cloudflare R2</p>
        </div>
        <Button onClick={() => setShowTriggerDialog(true)} disabled={statusSummary?.is_backup_running}>
          <Database className="mr-2 h-4 w-4" />
          {statusSummary?.is_backup_running ? '备份进行中...' : '手动备份'}
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-100 dark:bg-blue-900">
                <Database className="h-5 w-5 text-blue-600 dark:text-blue-400" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{statusSummary?.total_backups ?? '-'}</p>
                <p className="text-sm text-muted-foreground">总备份数</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-emerald-100 dark:bg-emerald-900">
                <CheckCircle className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{statusSummary?.successful_backups ?? '-'}</p>
                <p className="text-sm text-muted-foreground">成功</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-red-100 dark:bg-red-900">
                <XCircle className="h-5 w-5 text-red-600 dark:text-red-400" />
              </div>
              <div>
                <p className="text-2xl font-semibold">{statusSummary?.failed_backups ?? '-'}</p>
                <p className="text-sm text-muted-foreground">失败</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className={cn(
                'p-2 rounded-lg',
                statusSummary?.is_backup_running
                  ? 'bg-blue-100 dark:bg-blue-900'
                  : 'bg-slate-100 dark:bg-slate-800'
              )}>
                <RefreshCw className={cn(
                  'h-5 w-5',
                  statusSummary?.is_backup_running ? 'text-blue-600 dark:text-blue-400 animate-spin' : 'text-slate-600 dark:text-slate-400'
                )} />
              </div>
              <div>
                <p className="text-2xl font-semibold">
                  {statusSummary?.is_backup_running ? '进行中' : '空闲'}
                </p>
                <p className="text-sm text-muted-foreground">当前状态</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Last Backup Info */}
      {statusSummary?.last_backup && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4" />
              最近备份
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">备份类型</p>
                <p className="font-medium">{TYPE_LABELS[statusSummary.last_backup.backup_type]}</p>
              </div>
              <div>
                <p className="text-muted-foreground">状态</p>
                <Badge className={STATUS_COLORS[statusSummary.last_backup.status as BackupStatus]}>
                  {STATUS_LABELS[statusSummary.last_backup.status as BackupStatus]}
                </Badge>
              </div>
              <div>
                <p className="text-muted-foreground">备份时间</p>
                <p className="font-medium">{formatDatetime(statusSummary.last_backup.started_at)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">大小</p>
                <p className="font-medium">{formatBytes(statusSummary.last_backup.size_bytes)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex items-center justify-between mb-4">
          <TabsList>
            <TabsTrigger value="records">📋 备份记录</TabsTrigger>
            <TabsTrigger value="info">🔍 pgBackRest 信息</TabsTrigger>
          </TabsList>
          <Button size="sm" variant="outline" onClick={handleVerifyBackups}>
            <Shield className="mr-1 h-4 w-4" />
            验证备份
          </Button>
        </div>

        <TabsContent value="records">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : records.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Database className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
                <p className="text-muted-foreground mb-2">暂无备份记录</p>
                <p className="text-sm text-muted-foreground/70">
                  点击「手动备份」创建第一个备份，或等待每天凌晨 3:00 的自动备份
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-3 px-4 font-medium">ID</th>
                      <th className="text-left py-3 px-4 font-medium">类型</th>
                      <th className="text-left py-3 px-4 font-medium">状态</th>
                      <th className="text-left py-3 px-4 font-medium">开始时间</th>
                      <th className="text-left py-3 px-4 font-medium">完成时间</th>
                      <th className="text-left py-3 px-4 font-medium">大小</th>
                      <th className="text-left py-3 px-4 font-medium">耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map(record => (
                      <tr key={record.id} className="border-b border-border/30">
                        <td className="py-3 px-4 text-muted-foreground">#{record.id}</td>
                        <td className="py-3 px-4">
                          <Badge variant="outline">{TYPE_LABELS[record.backup_type] || record.backup_type}</Badge>
                        </td>
                        <td className="py-3 px-4">
                          <Badge className={STATUS_COLORS[record.status as BackupStatus]}>
                            {STATUS_LABELS[record.status as BackupStatus]}
                          </Badge>
                        </td>
                        <td className="py-3 px-4">{formatDatetime(record.started_at)}</td>
                        <td className="py-3 px-4">{formatDatetime(record.completed_at)}</td>
                        <td className="py-3 px-4">{formatBytes(record.size_bytes)}</td>
                        <td className="py-3 px-4">{formatDuration(record.duration_seconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="info">
          {backupInfo ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Info className="h-4 w-4" />
                  pgBackRest 备份信息
                </CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-xs bg-muted p-4 rounded-lg overflow-auto max-h-96">
                  {JSON.stringify(backupInfo.backups, null, 2)}
                </pre>
              </CardContent>
            </Card>
          ) : (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="h-6 w-6 animate-spin" />
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
    </div>
  )
}