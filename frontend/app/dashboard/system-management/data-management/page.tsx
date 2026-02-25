'use client'

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Database, XCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { useGlobalLoading } from '@/components/global-loading-provider'
import { cn } from '@/lib/utils'

type DataManagementStatus = {
  server_time: string
  database: {
    engine: string
    source: string | null
    healthy: boolean
    checked_at: string
  }
  cache: {
    sqlite_path: string
    exists: boolean
    file_size_bytes: number
    ttl_seconds: number
    total_entries: number
    expired_entries: number
    active_entries: number
    latest_updated_at: string | null
    nearest_expire_at: string | null
  }
}

type ClearCacheResponse = {
  cleared_at: string
  removed_entries: number
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''
const API_KEY = process.env.NEXT_PUBLIC_BACKEND_API_KEY ?? ''

// Local storage key for caching data
const CACHE_KEY = 'system-data-management-status'
const CACHE_TIMESTAMP_KEY = 'system-data-management-timestamp'
// Cache validity duration: 5 minutes
const CACHE_DURATION_MS = 5 * 60 * 1000

function authHeaders(): Record<string, string> {
  return API_KEY ? { 'X-API-Key': API_KEY } : {}
}

function formatDateTime(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(2)} MB`
}

async function parseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: string }
    return payload.detail || `请求失败 (${response.status})`
  } catch {
    const text = await response.text()
    return text || `请求失败 (${response.status})`
  }
}

// Helper functions for local storage cache
function getCachedData(): { data: DataManagementStatus | null; isFresh: boolean } {
  if (typeof window === 'undefined') {
    return { data: null, isFresh: false }
  }

  try {
    const cachedTimestamp = localStorage.getItem(CACHE_TIMESTAMP_KEY)
    const cachedData = localStorage.getItem(CACHE_KEY)

    if (!cachedTimestamp || !cachedData) {
      return { data: null, isFresh: false }
    }

    const timestamp = parseInt(cachedTimestamp, 10)
    const now = Date.now()
    const isFresh = now - timestamp < CACHE_DURATION_MS
    const parsedData = JSON.parse(cachedData) as DataManagementStatus

    return { data: parsedData, isFresh }
  } catch {
    return { data: null, isFresh: false }
  }
}

function setCachedData(data: DataManagementStatus): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data))
    localStorage.setItem(CACHE_TIMESTAMP_KEY, Date.now().toString())
  } catch {
    // Ignore storage errors
  }
}

function clearCachedData(): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    localStorage.removeItem(CACHE_KEY)
    localStorage.removeItem(CACHE_TIMESTAMP_KEY)
  } catch {
    // Ignore storage errors
  }
}

export default function SystemDataManagementPage() {
  const { withGlobalLoading } = useGlobalLoading()
  const [status, setStatus] = useState<DataManagementStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [cacheNotice, setCacheNotice] = useState<string | null>(null)

  // Core function to fetch data from API
  const fetchStatusFromAPI = useCallback(async (showLoading = true): Promise<DataManagementStatus | null> => {
    if (showLoading) {
      setLoading(true)
    }
    setError(null)

    try {
      const response = await fetch(`${API_BASE}/api/v1/system-management/data-management/status`, {
        headers: authHeaders(),
        cache: 'no-store',
      })
      if (!response.ok) {
        throw new Error(await parseError(response))
      }
      const payload = (await response.json()) as DataManagementStatus
      setStatus(payload)
      setCachedData(payload)
      return payload
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '状态加载失败')
      return null
    } finally {
      if (showLoading) {
        setLoading(false)
      }
    }
  }, [])

  // Main load function that checks cache first
  const loadStatus = useCallback(async (forceRefresh = false): Promise<void> => {
    if (forceRefresh) {
      setCacheNotice(null)
      await withGlobalLoading(() => fetchStatusFromAPI(true))
      return
    }

    const { data: cachedData, isFresh } = getCachedData()

    if (cachedData) {
      setStatus(cachedData)
      if (!isFresh) {
        setCacheNotice('当前展示的是历史缓存数据，请点击“刷新状态”获取最新信息。')
      } else {
        setCacheNotice(null)
      }
      return
    }

    setCacheNotice(null)
  }, [fetchStatusFromAPI, withGlobalLoading])

  // Initial load: only read local cache, never auto-request API.
  useEffect(() => {
    void loadStatus(false)
  }, [loadStatus])

  const onClearCache = async () => {
    await withGlobalLoading(async () => {
      setClearing(true)
      setError(null)
      setSuccessMessage(null)
      setCacheNotice(null)
      try {
        const response = await fetch(`${API_BASE}/api/v1/system-management/data-management/cache/clear`, {
          method: 'POST',
          headers: authHeaders(),
        })
        if (!response.ok) {
          throw new Error(await parseError(response))
        }
        const payload = (await response.json()) as ClearCacheResponse
        setSuccessMessage(`缓存清理完成：删除 ${payload.removed_entries} 条，时间 ${formatDateTime(payload.cleared_at)}`)
        setConfirmDialogOpen(false)
        // Clear local cache and reload
        clearCachedData()
        await loadStatus(true) // Force refresh
      } catch (clearError) {
        setError(clearError instanceof Error ? clearError.message : '清除缓存失败')
      } finally {
        setClearing(false)
      }
    })
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-6">
      <Card className="overflow-hidden border-border/80 shadow-[0_20px_40px_-22px_rgba(15,23,42,0.22)]">
        <CardContent className="space-y-8 p-5 sm:p-7 md:p-8">
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
            <div className="max-w-2xl space-y-2.5">
              <Badge variant="outline" className="w-fit rounded-md border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
                系统管理
              </Badge>
              <p className="text-sm leading-6 text-muted-foreground">查看数据库与缓存运行状态，并支持一键清除缓存。</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 self-start rounded-lg border border-border/70 bg-muted/30 p-1.5">
              <Button type="button" variant="outline" onClick={() => void loadStatus(true)} disabled={loading || clearing}>
                {loading ? '刷新中...' : '刷新状态'}
              </Button>
              <Button type="button" onClick={() => setConfirmDialogOpen(true)} disabled={loading || clearing}>
                {clearing ? '清理中...' : '清除缓存'}
              </Button>
            </div>
          </div>

          <Separator />

          {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">{error}</div> : null}
          {successMessage ? (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-700 dark:text-emerald-300">
              {successMessage}
            </div>
          ) : null}
          {cacheNotice ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-700 dark:text-amber-300">
              {cacheNotice}
            </div>
          ) : null}

          {!status && !loading ? (
            <div className="rounded-md border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
              暂无本地缓存数据。请点击“刷新状态”加载最新内容。
            </div>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-2">
            {/* 数据库状态卡片 */}
            <Card className="border-border/70 overflow-hidden">
              <CardHeader className="bg-gradient-to-r from-emerald-500/5 to-transparent pb-4">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base font-semibold">数据库状态</CardTitle>
                    <CardDescription className="text-xs mt-1">后端主库连通性和数据源信息</CardDescription>
                  </div>
                  <div className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full",
                    status?.database.healthy 
                      ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"
                      : "bg-destructive/10 text-destructive"
                  )}>
                    {status?.database.healthy ? <CheckCircle2 className="h-5 w-5" /> : <XCircle className="h-5 w-5" />}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1 rounded-lg bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">数据库引擎</p>
                    <p className="text-sm font-medium">{status?.database.engine || '-'}</p>
                  </div>
                  <div className="space-y-1 rounded-lg bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">检查时间</p>
                    <p className="text-sm font-medium">{formatDateTime(status?.database.checked_at ?? null)}</p>
                  </div>
                </div>
                <div className="mt-4 space-y-1 rounded-lg bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">数据源</p>
                  <p className="break-all text-sm font-mono text-xs">{status?.database.source || '-'}</p>
                </div>
              </CardContent>
            </Card>

            {/* 缓存状态卡片 */}
            <Card className="border-border/70 overflow-hidden">
              <CardHeader className="bg-gradient-to-r from-blue-500/5 to-transparent pb-4">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base font-semibold">缓存状态</CardTitle>
                    <CardDescription className="text-xs mt-1">SQLite 查询缓存与 TTL 信息</CardDescription>
                  </div>
                  <div className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full",
                    status?.cache.exists 
                      ? "bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
                      : "bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400"
                  )}>
                    <Database className="h-5 w-5" />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-4 space-y-4">
                {/* 文件信息组 */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1 rounded-lg bg-muted/30 p-3 text-center">
                    <p className="text-xs text-muted-foreground">缓存文件</p>
                    <p className={cn("text-sm font-semibold", status?.cache.exists ? "text-blue-600 dark:text-blue-400" : "text-amber-600")}>
                      {status?.cache.exists ? '已就绪' : '未创建'}
                    </p>
                  </div>
                  <div className="space-y-1 rounded-lg bg-muted/30 p-3 text-center">
                    <p className="text-xs text-muted-foreground">文件大小</p>
                    <p className="text-sm font-semibold">{status ? formatBytes(status.cache.file_size_bytes) : '-'}</p>
                  </div>
                  <div className="space-y-1 rounded-lg bg-muted/30 p-3 text-center">
                    <p className="text-xs text-muted-foreground">TTL</p>
                    <p className="text-sm font-semibold">{status ? `${status.cache.ttl_seconds} 秒` : '-'}</p>
                  </div>
                </div>

                {/* 缓存路径 */}
                <div className="space-y-1 rounded-lg bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">缓存路径</p>
                  <p className="break-all text-xs font-mono">{status?.cache.sqlite_path || '-'}</p>
                </div>

                {/* 统计数据 */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1 rounded-lg bg-blue-50/50 dark:bg-blue-950/20 p-3 text-center border border-blue-100 dark:border-blue-900">
                    <p className="text-xs text-muted-foreground">总记录数</p>
                    <p className="text-lg font-bold text-blue-600 dark:text-blue-400">{status?.cache.total_entries ?? '-'}</p>
                  </div>
                  <div className="space-y-1 rounded-lg bg-emerald-50/50 dark:bg-emerald-950/20 p-3 text-center border border-emerald-100 dark:border-emerald-900">
                    <p className="text-xs text-muted-foreground">有效记录</p>
                    <p className="text-lg font-bold text-emerald-600 dark:text-emerald-400">{status?.cache.active_entries ?? '-'}</p>
                  </div>
                  <div className="space-y-1 rounded-lg bg-amber-50/50 dark:bg-amber-950/20 p-3 text-center border border-amber-100 dark:border-amber-900">
                    <p className="text-xs text-muted-foreground">过期记录</p>
                    <p className="text-lg font-bold text-amber-600 dark:text-amber-400">{status?.cache.expired_entries ?? '-'}</p>
                  </div>
                </div>

                {/* 时间信息 */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1 rounded-lg bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">最近写入</p>
                    <p className="text-sm font-medium">{formatDateTime(status?.cache.latest_updated_at ?? null)}</p>
                  </div>
                  <div className="space-y-1 rounded-lg bg-muted/30 p-3">
                    <p className="text-xs text-muted-foreground">最近到期</p>
                    <p className="text-sm font-medium">{formatDateTime(status?.cache.nearest_expire_at ?? null)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <p className="text-xs leading-5 text-muted-foreground">
            页面默认优先展示本地缓存；点击“刷新状态”后会从服务端拉取最新数据。执行“清除缓存”会清空后端查询缓存，并同步更新当前状态。
          </p>
        </CardContent>
      </Card>

      <Dialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认清除缓存</DialogTitle>
            <DialogDescription>
              该操作会删除缓存数据库中的全部查询缓存记录。操作不可撤销，但不会影响主数据库数据。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmDialogOpen(false)} disabled={clearing}>
              取消
            </Button>
            <Button type="button" onClick={() => void onClearCache()} disabled={clearing}>
              {clearing ? '清理中...' : '确认清除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
