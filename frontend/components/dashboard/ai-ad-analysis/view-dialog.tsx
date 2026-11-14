'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Loader2, Pencil, Save, X } from 'lucide-react'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { InsightMarkdown } from '@/components/insight'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import styles from './ai-ad-analysis-warm.module.css'
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
          dimension_id: name,
          name,
          level: 2,
        })),
        temporal: (evo.temporal_analyses_performed ?? []).map((name: string) => ({
          dimension_id: name,
          name,
          level: 3,
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
      <DialogContent className={styles.dialogContent}>
        <DialogHeader className={styles.dialogHeader}>
          <div className={styles.dialogHeaderRow}>
            <div className={styles.dialogTitleBlock}>
              <DialogTitle className={`${styles.dialogTitle} truncate`}>
                {insight?.title ?? '加载中...'}
              </DialogTitle>
              {insight && (
                <p className={styles.dialogMeta}>
                  {insight.project_name} · {insight.country} · {insight.date_range_start} ~{' '}
                  {insight.date_range_end}
                </p>
              )}
            </div>
            <div className={styles.dialogActions}>
              {insight && !editing && (
                <>
                  <WarmButton type="button" variant="secondary" onClick={handleCopy}>
                    {copied ? (
                      <>
                        <Check aria-hidden />
                        已复制
                      </>
                    ) : (
                      <>
                        <Copy aria-hidden />
                        复制
                      </>
                    )}
                  </WarmButton>
                  <WarmButton type="button" variant="secondary" onClick={handleEdit}>
                    <Pencil aria-hidden />
                    编辑
                  </WarmButton>
                </>
              )}
              {editing && (
                <>
                  <WarmButton
                    type="button"
                    variant="secondary"
                    onClick={() => setEditing(false)}
                    disabled={saving}
                  >
                    <X aria-hidden />
                    取消
                  </WarmButton>
                  <WarmButton
                    type="button"
                    variant="primary"
                    onClick={handleSave}
                    loading={saving}
                    loadingLabel="正在保存广告分析"
                  >
                    {!saving && <Save aria-hidden />}
                    保存
                  </WarmButton>
                </>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className={styles.dialogBody}>
          {loading && (
            <div className={styles.loadingState} role="status">
              <Loader2 className="animate-spin" aria-hidden />
            </div>
          )}

          {error && (
            <div className={styles.dialogError} role="alert">
              {error}
            </div>
          )}

          {insight && !editing && (
            <div className={styles.detailStack}>
              {dimensionCoverage && (
                <DimensionPanel coverage={dimensionCoverage} defaultExpanded={false} />
              )}
              <div className={styles.detailContent}>
                <InsightMarkdown
                  content={insight.content}
                  state="final"
                  appearance="warm"
                  exportFileName={`${insight.title || '广告分析'}.md`}
                />
              </div>
            </div>
          )}

          {editing && (
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className={styles.textarea}
              placeholder="Markdown 内容..."
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
