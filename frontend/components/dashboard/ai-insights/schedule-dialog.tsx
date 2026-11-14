'use client'

import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, Calendar, Clock, FileText } from 'lucide-react'
import type {
  InsightScheduleItem,
  InsightScheduleCreate,
  InsightScheduleUpdate,
  ProjectOption,
} from '@/lib/api/ai-insight-schedules'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import styles from './schedule-mobile.module.css'

interface ScheduleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  schedule?: InsightScheduleItem | null
  onSave: (data: InsightScheduleCreate | InsightScheduleUpdate) => Promise<void>
  /** When provided, insight_type is locked to this value and the selector is hidden */
  fixedInsightType?: string
}

const EMPTY_FORM = {
  project_id: null as number | null,
  country: 'US' as 'US' | 'DE' | 'UK',
  insight_type: 'daily' as 'daily' | 'weekly' | 'monthly' | 'custom',
  cron_expression: '0 7 * * *',
  date_range_strategy: 'yesterday' as
    | 'yesterday'
    | 'last_7d'
    | 'last_30d'
    | 'prev_month'
    | 'current_month'
    | 'last_week',
  model: null as string | null,
}

export function ScheduleDialog({
  open,
  onOpenChange,
  schedule,
  onSave,
  fixedInsightType,
}: ScheduleDialogProps) {
  const isEdit = !!schedule
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)

  const [form, setForm] = useState(EMPTY_FORM)

  // Load projects on mount
  useEffect(() => {
    async function loadProjects() {
      try {
        const data = await fetchManagedProjectsCached<Array<{ id: number; name: string }>>()
        setProjects(data.map((p) => ({ id: p.id, name: p.name })))
      } catch (e) {
        console.error('Failed to load projects', e)
      } finally {
        setProjectsLoading(false)
      }
    }
    if (open) {
      loadProjects()
    }
  }, [open])

  // Reset form when dialog opens/closes or schedule changes
  useEffect(() => {
    if (open) {
      if (schedule) {
        setForm({
          project_id: schedule.project_id,
          country: schedule.country as 'US' | 'DE' | 'UK',
          insight_type: (fixedInsightType ||
            schedule.insight_type) as typeof EMPTY_FORM.insight_type,
          cron_expression: schedule.cron_expression,
          date_range_strategy: schedule.date_range_strategy as any,
          model: schedule.model,
        })
      } else {
        setForm({
          ...EMPTY_FORM,
          insight_type: (fixedInsightType ||
            EMPTY_FORM.insight_type) as typeof EMPTY_FORM.insight_type,
        })
      }
      setError(null)
    }
  }, [open, schedule, fixedInsightType])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!form.project_id) {
      setError('请选择项目')
      return
    }

    setLoading(true)
    try {
      if (isEdit && schedule) {
        // Update mode: exclude project_id
        const updateData: InsightScheduleUpdate = {
          country: form.country,
          insight_type: form.insight_type,
          cron_expression: form.cron_expression,
          date_range_strategy: form.date_range_strategy,
          model: form.model || undefined,
        }
        await onSave(updateData)
      } else {
        // Create mode
        const createData: InsightScheduleCreate = {
          project_id: form.project_id,
          country: form.country,
          insight_type: form.insight_type,
          cron_expression: form.cron_expression,
          date_range_strategy: form.date_range_strategy,
          model: form.model || null,
        }
        await onSave(createData)
      }
      onOpenChange(false)
    } catch (e: any) {
      setError(e.message || '保存失败')
    } finally {
      setLoading(false)
    }
  }

  // Quick cron presets
  const cronPresets = [
    { label: '06:00', value: '0 6 * * *' },
    { label: '07:00', value: '0 7 * * *' },
    { label: '08:00', value: '0 8 * * *' },
    { label: '09:00', value: '0 9 * * *' },
    { label: '每周一 07:00', value: '0 7 * * 1' },
    { label: '每月1号 07:00', value: '0 7 1 * *' },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`${styles.dialogContent} sm:max-w-[560px]`}>
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑定时任务' : '新建定时任务'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? '修改定时生成 AI Insight 的配置'
              : '创建一个定时任务，自动在指定时间生成 AI Insight 报告'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className={`space-y-5 ${styles.form}`}>
          {/* Error message */}
          {error && (
            <div className="rounded-lg bg-term-neg/5 border border-term-neg/30 px-4 py-3 text-sm text-term-neg">
              {error}
            </div>
          )}

          {/* Project (only for create) */}
          {!isEdit && (
            <div className="space-y-2">
              <Label htmlFor="project">项目</Label>
              <Select
                value={form.project_id?.toString() || ''}
                onValueChange={(v) => setForm({ ...form, project_id: parseInt(v) })}
                disabled={projectsLoading}
              >
                <SelectTrigger id="project">
                  <SelectValue placeholder="选择项目" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>项目列表</SelectLabel>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id.toString()}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Country */}
          <div className="space-y-2">
            <Label htmlFor="country">站点</Label>
            <Select
              value={form.country}
              onValueChange={(v) => setForm({ ...form, country: v as 'US' | 'DE' | 'UK' })}
            >
              <SelectTrigger id="country">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>站点</SelectLabel>
                  <SelectItem value="US">美国站 (US)</SelectItem>
                  <SelectItem value="DE">德国站 (DE)</SelectItem>
                  <SelectItem value="UK">英国站 (UK)</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          {/* Insight Type (hidden when fixedInsightType is provided) */}
          {!fixedInsightType && (
            <div className="space-y-2">
              <Label htmlFor="insight_type">
                <FileText className="inline-block w-4 h-4 mr-1.5 -mt-0.5" />
                洞察类型
              </Label>
              <Select
                value={form.insight_type}
                onValueChange={(v) =>
                  setForm({ ...form, insight_type: v as typeof form.insight_type })
                }
              >
                <SelectTrigger id="insight_type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>洞察类型</SelectLabel>
                    <SelectItem value="daily">日报</SelectItem>
                    <SelectItem value="weekly">周报</SelectItem>
                    <SelectItem value="monthly">月报</SelectItem>
                    <SelectItem value="custom">自定义</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Cron Expression with presets */}
          <div className="space-y-2">
            <Label htmlFor="cron">
              <Clock className="inline-block w-4 h-4 mr-1.5 -mt-0.5" />
              执行时间
            </Label>
            <div className="flex flex-wrap gap-2 mb-2">
              {cronPresets.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => setForm({ ...form, cron_expression: preset.value })}
                  className={`${styles.cronPreset} px-3 py-1.5 text-xs rounded-full border transition-colors ${
                    form.cron_expression === preset.value
                      ? 'bg-primary text-white border-primary'
                      : 'bg-background hover:bg-muted border-border'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <Input
              id="cron"
              value={form.cron_expression}
              onChange={(e) => setForm({ ...form, cron_expression: e.target.value })}
              placeholder="0 7 * * *"
              className={`font-mono text-sm ${styles.textInput}`}
            />
            <p className="text-xs text-muted-foreground">
              格式：分 时 日 月 周，例如 0 7 * * * 表示每天 07:00
            </p>
          </div>

          {/* Date Range Strategy */}
          <div className="space-y-2">
            <Label htmlFor="date_range_strategy">
              <Calendar className="inline-block w-4 h-4 mr-1.5 -mt-0.5" />
              数据日期范围
            </Label>
            <Select
              value={form.date_range_strategy}
              onValueChange={(v) =>
                setForm({ ...form, date_range_strategy: v as typeof form.date_range_strategy })
              }
            >
              <SelectTrigger id="date_range_strategy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>日期范围</SelectLabel>
                  <SelectItem value="yesterday">昨日（单日）</SelectItem>
                  <SelectItem value="last_7d">近 7 天</SelectItem>
                  <SelectItem value="last_30d">近 30 天</SelectItem>
                  <SelectItem value="prev_month">上月整月</SelectItem>
                  <SelectItem value="current_month">当月至今</SelectItem>
                  <SelectItem value="last_week">上周（周一至周日）</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">定义生成洞察时所分析的数据时间范围</p>
          </div>

          {/* Model (optional) */}
          <div className="space-y-2">
            <Label htmlFor="model">AI 模型（可选）</Label>
            <Input
              id="model"
              value={form.model || ''}
              onChange={(e) => setForm({ ...form, model: e.target.value || null })}
              placeholder="留空使用默认模型"
              className={styles.textInput}
            />
            <p className="text-xs text-muted-foreground">可指定不同的 AI 模型覆盖默认配置</p>
          </div>

          <DialogFooter className={styles.dialogFooter}>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
              className={styles.dialogButton}
            >
              取消
            </Button>
            <Button type="submit" disabled={loading} className={styles.dialogButton}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isEdit ? '保存修改' : '创建定时任务'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
