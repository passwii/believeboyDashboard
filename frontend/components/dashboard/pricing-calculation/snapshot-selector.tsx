'use client'

import { useEffect, useState } from 'react'
import { Camera, ChevronDown, Clock, Loader2, Pencil, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { useNotifications } from '@/components/notifications'

const API_BASE = '/api/backend'

export interface PricingSnapshotOption {
  id: number
  project_id: number
  project_name: string
  country: string
  snapshot_date: string
  name: string | null
  description: string | null
  row_count: number
  created_by: string | null
  created_at: string
  summary: {
    total: number
    calculated: number
    profitable: number
    passRate: number
  }
}

interface PricingSnapshotSelectorProps {
  projectId: number | null
  country: string
  selectedSnapshotId: number | null
  onSnapshotSelect: (snapshotId: number | null) => void
  onCreateSnapshot: () => void
  onEditSnapshot: (snapshot: PricingSnapshotOption) => void
  disabled?: boolean
  refreshNonce?: number
  isAdmin?: boolean
  onDeleteSnapshot?: (snapshotId: number) => void
}

function formatSnapshotLabel(snapshot: PricingSnapshotOption): string {
  if (snapshot.name && snapshot.name.trim()) return snapshot.name
  const date = new Date(snapshot.snapshot_date)
  const dateStr = date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
  return `快照 ${dateStr}`
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

export function PricingSnapshotSelector({
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
}: PricingSnapshotSelectorProps) {
  const { notify } = useNotifications()
  const [snapshots, setSnapshots] = useState<PricingSnapshotOption[]>([])
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  useEffect(() => {
    if (!projectId) {
      setSnapshots([])
      setLoading(false)
      return
    }

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
          `${API_BASE}/api/v1/pricing-calculation-snapshots?${params.toString()}`
        )
        if (!response.ok) throw new Error('加载失败')
        if (!active) return
        const data = (await response.json()) as PricingSnapshotOption[]
        setSnapshots(data)
      } catch (e) {
        console.error('Failed to load pricing snapshots:', e)
        if (active) setSnapshots([])
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [projectId, country, refreshNonce])

  const selectedSnapshot = snapshots.find((s) => s.id === selectedSnapshotId)
  const isLiveMode = selectedSnapshotId === null

  async function handleDelete(e: React.MouseEvent, snapshotId: number) {
    e.stopPropagation()
    if (!confirm('确定要删除此快照吗？此操作不可恢复。')) return
    setDeletingId(snapshotId)
    try {
      const response = await fetch(
        `${API_BASE}/api/v1/pricing-calculation-snapshots/${snapshotId}`,
        { method: 'DELETE' }
      )
      if (!response.ok) {
        const err = await response.json().catch(() => null)
        throw new Error(err?.detail || '删除失败')
      }
      if (selectedSnapshotId === snapshotId) {
        onSnapshotSelect(null)
      }
      onDeleteSnapshot?.(snapshotId)
      notify({ type: 'success', title: '快照已删除' })
    } catch (err) {
      console.error('Failed to delete pricing snapshot:', err)
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
            <span className="text-xs text-term-muted">使用当前最新核算结果</span>
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
                  <span className="truncate">{formatSnapshotLabel(snapshot)}</span>
                  <span className="text-xs text-term-muted">
                    {snapshot.created_by ? `${snapshot.created_by} · ` : ''}
                    {formatRelativeTime(snapshot.created_at)} · {snapshot.row_count} 个 SKU
                  </span>
                </div>
                {selectedSnapshotId === snapshot.id && <Badge className="ml-auto">当前</Badge>}
                {isAdmin && (
                  <div className="flex items-center gap-1 ml-auto">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 opacity-0 group-hover/snapshot:opacity-100 text-term-muted hover:text-term-accent"
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
                      className="h-6 w-6 p-0 opacity-0 group-hover/snapshot:opacity-100 text-term-muted hover:text-term-neg"
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
