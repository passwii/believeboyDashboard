'use client'

import { useState, useEffect } from 'react'
import { Camera, ChevronDown, Clock, Loader2, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNotifications } from '@/components/notifications'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'

const API_BASE = '/api/backend'

export interface SnapshotOption {
  id: number
  project_id: number
  project_name: string
  country: string
  snapshot_date: string
  is_current: boolean
  name: string | null
  description: string | null
  inventory_report_date: string | null
  business_report_date: string | null
  sales_report_date: string | null
  row_count: number
  created_by: string | null
  created_at: string
  summary: {
    sku_count: number
    out_of_stock_risk_count: number
    healthy_count: number
    slow_moving_count: number
    pending_data_count: number
    total_available_inventory: number
    total_in_transit_quantity: number
  }
}

export interface SnapshotSelectorProps {
  projectId: number | null
  country: string
  selectedSnapshotId: number | null
  onSnapshotSelect: (snapshotId: number | null) => void
  onCreateSnapshot: () => void
  onEditSnapshot: (snapshot: SnapshotOption) => void
  disabled?: boolean
  refreshNonce?: number
  isAdmin?: boolean
  onDeleteSnapshot?: (snapshotId: number) => void
}

function formatSnapshotLabel(snapshot: SnapshotOption): string {
  const date = new Date(snapshot.snapshot_date)
  const dateStr = date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
  return snapshot.name || `快照 ${dateStr}`
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return '刚刚'
  if (diffMins < 60) return `${diffMins} 分钟前`
  if (diffHours < 24) return `${diffHours} 小时前`
  if (diffDays < 7) return `${diffDays} 天前`
  return date.toLocaleDateString('zh-CN')
}

export function SnapshotSelector({
  projectId,
  country,
  selectedSnapshotId,
  onSnapshotSelect,
  onCreateSnapshot,
  onEditSnapshot,
  disabled = false,
  refreshNonce = 0,
  isAdmin = false,
  onDeleteSnapshot,
}: SnapshotSelectorProps) {
  const { notify } = useNotifications()
  const [snapshots, setSnapshots] = useState<SnapshotOption[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  // BEL-423 页内懒加载：快照列表推迟到下拉首次打开才取数；已打开过的作用域
  // （项目/国家/刷新序号）不重复请求。避免 mount 即多一个列表请求。
  const [loadedScope, setLoadedScope] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) {
      setSnapshots([])
      setLoading(false)
      setLoadedScope(null)
      return
    }
    if (!open) return
    const scope = `${projectId}:${country}:${refreshNonce}`
    if (scope === loadedScope) return

    let active = true
    async function load() {
      setLoading(true)
      try {
        const params = new URLSearchParams({
          project_id: String(projectId),
          country,
          page: '1',
          page_size: '50',
        })
        const response = await fetch(
          `${API_BASE}/api/v1/inventory-replenishment-snapshots?${params.toString()}`
        )
        if (!response.ok) throw new Error('加载失败')
        if (!active) return
        const data = await response.json()
        setSnapshots(data)
        setLoadedScope(scope)
      } catch (e) {
        console.error('Failed to load snapshots:', e)
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [open, projectId, country, refreshNonce, loadedScope])

  const selectedSnapshot = snapshots.find((s) => s.id === selectedSnapshotId)
  const isLiveMode = selectedSnapshotId === null

  async function handleDelete(e: React.MouseEvent, snapshotId: number) {
    e.stopPropagation()
    if (!confirm('确定要删除此快照吗？此操作不可恢复。')) return
    setDeletingId(snapshotId)
    try {
      const response = await fetch(
        `${API_BASE}/api/v1/inventory-replenishment-snapshots/${snapshotId}`,
        { method: 'DELETE' }
      )
      if (!response.ok) {
        const err = await response.json().catch(() => null)
        throw new Error(err?.detail || '删除失败')
      }
      // If the deleted snapshot was selected, switch back to live mode
      if (selectedSnapshotId === snapshotId) {
        onSnapshotSelect(null)
      }
      onDeleteSnapshot?.(snapshotId)
    } catch (err) {
      console.error('Failed to delete snapshot:', err)
      notify({ type: 'error', title: err instanceof Error ? err.message : '删除失败' })
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} className="gap-2">
          {isLiveMode ? (
            <>
              <Clock className="h-4 w-4" />
              实时数据
              <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
                LIVE
              </Badge>
            </>
          ) : (
            <>
              <Camera className="h-4 w-4" />
              {selectedSnapshot ? formatSnapshotLabel(selectedSnapshot) : '选择快照'}
            </>
          )}
          <ChevronDown className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuItem
          onClick={() => {
            onSnapshotSelect(null)
            setOpen(false)
          }}
        >
          <Clock className="mr-2 h-4 w-4" />
          <div className="flex flex-col">
            <span>实时数据</span>
            <span className="text-xs text-term-muted">使用最新数据计算</span>
          </div>
          {isLiveMode && <Badge className="ml-auto">当前</Badge>}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {loading ? (
          <div className="p-4 space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : snapshots.length === 0 ? (
          <div className="p-4 text-center text-sm text-term-muted">暂无快照</div>
        ) : (
          <>
            {snapshots.map((snapshot) => (
              <DropdownMenuItem
                key={snapshot.id}
                onClick={() => {
                  onSnapshotSelect(snapshot.id)
                  setOpen(false)
                }}
                className="group/snapshot"
              >
                <Camera className="mr-2 h-4 w-4" />
                <div className="flex flex-col min-w-0 flex-1">
                  <span>{formatSnapshotLabel(snapshot)}</span>
                  <span className="text-xs text-term-muted">
                    {snapshot.created_by ? `${snapshot.created_by} · ` : ''}
                    {formatRelativeTime(snapshot.created_at)}
                  </span>
                </div>
                {selectedSnapshotId === snapshot.id && <Badge className="ml-auto">当前</Badge>}
                {isAdmin && (
                  <div className="flex items-center gap-1 ml-auto">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 opacity-0 group-hover/snapshot:opacity-100 text-term-muted hover:text-primary"
                      onClick={(e) => {
                        e.stopPropagation()
                        onEditSnapshot(snapshot)
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 opacity-0 group-hover/snapshot:opacity-100 text-term-muted hover:text-destructive"
                      disabled={deletingId === snapshot.id}
                      onClick={(e) => void handleDelete(e, snapshot.id)}
                    >
                      {deletingId === snapshot.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={() => {
            onCreateSnapshot()
            setOpen(false)
          }}
          disabled={!projectId}
        >
          <Camera className="mr-2 h-4 w-4" />
          保存当前数据为快照
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
