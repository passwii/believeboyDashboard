'use client'

import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check,
  Copy,
  Loader2,
  Pencil,
  Save,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { DimensionPanel, type DimensionCoverage } from './dimension-panel'

export interface InsightDetail {
  id: number
  project_id: number
  project_name: string
  country: string
  title: string
  content: string
  insight_type: string
  date_range_start: string
  date_range_end: string
  status: string
  sub_status: string | null
  error_message?: string | null
  strategy_metadata?: string | null
  created_by: string
  created_at: string
  updated_at: string
}

interface ViewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  insightId: number | null
  onUpdated?: () => void
}

export function ViewDialog({ open, onOpenChange, insightId, onUpdated }: ViewDialogProps) {
  const [loading, setLoading] = useState(false)
  const [insight, setInsight] = useState<InsightDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)

  // Parse strategy metadata for dimension panel
  const dimensionCoverage: DimensionCoverage | null = (() => {
    if (!insight?.strategy_metadata) return null
    try {
      const meta = JSON.parse(insight.strategy_metadata)
      const evo = meta.evolution_metadata
      if (!evo) return null
      return {
        analyzed: evo.dimensions_analyzed ?? [],
        cross: (evo.cross_analyses_performed ?? []).map((name: string) => ({
          dimension_id: name, name, level: 2,
        })),
        temporal: (evo.temporal_analyses_performed ?? []).map((name: string) => ({
          dimension_id: name, name, level: 3,
        })),
        skipped: evo.dimensions_skipped ?? [],
      }
    } catch {
      return null
    }
  })()

  useEffect(() => {
    if (!open || !insightId) {
      setInsight(null)
      setEditing(false)
      return
    }

    setLoading(true)
    setError(null)

    fetch(`/api/backend/v1/ai-insights/${insightId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`加载失败: ${res.status}`)
        return res.json()
      })
      .then((data) => setInsight(data))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [open, insightId])

  const handleCopy = useCallback(async () => {
    if (!insight?.content) return
    try {
      await navigator.clipboard.writeText(insight.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }, [insight])

  const handleEdit = () => {
    if (!insight) return
    setEditContent(insight.content)
    setEditing(true)
  }

  const handleSave = async () => {
    if (!insight) return
    setSaving(true)
    try {
      const res = await fetch(`/api/backend/v1/ai-insights/${insight.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent }),
      })
      if (!res.ok) throw new Error('保存失败')
      const updated = await res.json()
      setInsight(updated)
      setEditing(false)
      onUpdated?.()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate">
                {insight?.title ?? '加载中...'}
              </DialogTitle>
              {insight && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {insight.project_name} · {insight.country} · {insight.date_range_start} ~ {insight.date_range_end}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-4">
              {insight && !editing && (
                <>
                  <Button variant="outline" size="sm" onClick={handleCopy}>
                    {copied ? (
                      <>
                        <Check className="mr-1 h-3.5 w-3.5 text-emerald-500" />
                        已复制
                      </>
                    ) : (
                      <>
                        <Copy className="mr-1 h-3.5 w-3.5" />
                        复制
                      </>
                    )}
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleEdit}>
                    <Pencil className="mr-1 h-3.5 w-3.5" />
                    编辑
                  </Button>
                </>
              )}
              {editing && (
                <>
                  <Button variant="outline" size="sm" onClick={() => setEditing(false)} disabled={saving}>
                    <X className="mr-1 h-3.5 w-3.5" />
                    取消
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={saving}>
                    {saving ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="mr-1 h-3.5 w-3.5" />
                    )}
                    保存
                  </Button>
                </>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-1">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {insight && !editing && (
            <div className="space-y-3">
              {dimensionCoverage && (
                <DimensionPanel coverage={dimensionCoverage} defaultExpanded={false} />
              )}
              <div className="rounded-md border bg-card p-5">
              <div
                className={cn(
                  'prose prose-sm dark:prose-invert max-w-none',
                  '[&_a]:font-medium [&_a]:text-primary',
                  '[&_h1]:mt-6 [&_h1]:text-xl [&_h1]:font-semibold',
                  '[&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-semibold',
                  '[&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold',
                  '[&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_th]:bg-muted/40 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:text-sm',
                  '[&_blockquote]:border-l-4 [&_blockquote]:border-primary/40 [&_blockquote]:bg-primary/5 [&_blockquote]:py-2 [&_blockquote]:pl-4 [&_blockquote]:pr-2 [&_blockquote]:my-3 [&_blockquote]:italic',
                  '[&_code:not(pre_code)]:rounded [&_code:not(pre_code)]:bg-muted [&_code:not(pre_code)]:px-1.5 [&_code:not(pre_code)]:py-0.5 [&_code:not(pre_code)]:text-xs [&_code:not(pre_code)]:font-mono',
                )}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{insight.content}</ReactMarkdown>
              </div>
            </div>
            </div>
          )}

          {editing && (
            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="min-h-[400px] font-mono text-sm"
              placeholder="Markdown 内容..."
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
