'use client'

/**
 * 库存健康 AI 分析 — 单项目单站点快照口径
 * 路径: /dashboard/ai/inventory-health
 *
 * 口径与广告不同：库存是**单日快照**（`report_date` 可缺省 = 最新快照），
 * 没有日期区间，也没有广告那样的历史列表（canonical 侧暂无 list 端点）。
 *
 * 页面只做容器：口径表单 + 共享 `InsightStreamPanel`。run 的提交、订阅、
 * 重连、恢复、取消、重试全在 `useInventoryInsight` → `useInsightDomainRun`
 * → `useInsightStream`，本页不创建 EventSource、不解析 SSE。
 */

import { useCallback, useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { Bot, Calendar, Database, RotateCcw, Sparkles } from 'lucide-react'

import { InsightStreamPanel } from '@/components/insight'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SingleDatePicker, COUNTRY_TIMEZONE_MAP } from '@/components/ui/date-picker'
import { TermPanel } from '@/components/terminal/term-panel'
import { useNotifications } from '@/components/notifications'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import {
  INVENTORY_LATEST_SNAPSHOT_HINT,
  inventoryScopeLabel,
  useInventoryInsight,
  type InventoryRunScope,
} from '@/components/dashboard/ai-inventory-health'

const COUNTRY_OPTIONS = [
  { value: 'US', label: '美国站 (US)' },
  { value: 'DE', label: '德国站 (DE)' },
  { value: 'UK', label: '英国站 (UK)' },
]

type Project = {
  id: number
  name: string
  brand_name?: string | null
}

export default function InventoryHealthPage() {
  const { data: session } = useSession()
  const { notify } = useNotifications()

  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState<number | null>(null)
  const [country, setCountry] = useState('US')
  const [reportDate, setReportDate] = useState<Date | null>(null)
  /** 已提交的口径快照：非 null 即表示开了一次分析，之后改动表单不影响在跑的 run */
  const [submitted, setSubmitted] = useState<InventoryRunScope | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchManagedProjectsCached<Project[]>(session, false)
      .then((items) => {
        if (cancelled) return
        const list = Array.isArray(items) ? items : []
        setProjects(list)
        if (list.length > 0) setProjectId(list[0].id)
      })
      .catch((err) => {
        notify({ type: 'error', title: '项目列表加载失败', message: String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [session, notify])

  const draftScope: InventoryRunScope = { projectId, country, reportDate }
  const activeScope = submitted ?? draftScope
  const { panel } = useInventoryInsight({ open: submitted !== null, scope: activeScope })

  const handleGenerate = useCallback(() => {
    if (!projectId) return
    setSubmitted({ projectId, country, reportDate })
  }, [projectId, country, reportDate])

  const activeLabel = inventoryScopeLabel(activeScope)
  const started = submitted !== null

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <TermPanel bodyClassName="p-3">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
          <div className="md:col-span-4">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">项目</label>
            <Select
              value={projectId ? String(projectId) : ''}
              onValueChange={(v) => setProjectId(Number(v))}
            >
              <SelectTrigger>
                <SelectValue placeholder="选择项目" />
              </SelectTrigger>
              <SelectContent>
                {projects.length === 0 ? (
                  <SelectItem value="__empty__" disabled>
                    暂无可用项目
                  </SelectItem>
                ) : (
                  projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.brand_name ? `${p.name} · ${p.brand_name}` : p.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="md:col-span-2">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">国家</label>
            <Select value={country} onValueChange={setCountry}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COUNTRY_OPTIONS.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="md:col-span-4">
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                口径日期
              </span>
              <span className="ml-2 font-normal normal-case text-term-faint">
                {INVENTORY_LATEST_SNAPSHOT_HINT}
              </span>
            </label>
            <SingleDatePicker
              value={reportDate ?? undefined}
              onChange={(date) => setReportDate(date ?? null)}
              clearable
              placeholder="最新库存快照"
              timezone={COUNTRY_TIMEZONE_MAP[country]}
            />
          </div>

          <div className="flex items-end md:col-span-2">
            <Button onClick={handleGenerate} disabled={!projectId} className="w-full">
              {started ? (
                <RotateCcw className="mr-2 h-4 w-4" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              {started ? '重新分析' : '立即生成'}
            </Button>
          </div>
        </div>
      </TermPanel>

      {started ? (
        <InsightStreamPanel
          status={panel.state.status}
          statusLabel={panel.state.label}
          progress={panel.state.progress}
          error={panel.error}
          backgroundMessage={panel.backgroundMessage}
          content={panel.content}
          contentState={panel.contentState}
          isStreaming={panel.state.isStreaming}
          digest={panel.digest}
          onRetry={panel.onRetry}
          onCancel={panel.onCancel}
          exportFileName={`库存健康-${activeLabel.replace(/[\\/:*?"<>|]/g, '-')}.md`}
          className="rounded-none"
          contentClassName="max-h-[60vh]"
          slots={{
            header: (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {panel.title ?? '库存健康分析'}
                  </p>
                  <p className="text-xs text-term-muted">{activeLabel}</p>
                </div>
              </div>
            ),
            meta: (
              <p className="text-xs text-term-faint">
                正文「数据局限」段落给出快照新鲜度与缺失维度；表单未指定口径日期时按最新快照分析。
              </p>
            ),
          }}
          emptyState={
            panel.state.status === 'failed' ? (
              <div className="flex flex-col items-center gap-2 py-12 text-term-neg">
                <Bot className="h-8 w-8 opacity-40" aria-hidden />
                <span className="text-xs">本轮库存健康分析未产出内容</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-12 text-term-muted">
                <Bot className="h-8 w-8 animate-pulse opacity-40" aria-hidden />
                <span className="text-xs">{panel.state.label}，内容会实时出现在这里</span>
              </div>
            )
          }
        />
      ) : (
        <TermPanel bodyClassName="p-8">
          <div className="flex flex-col items-center gap-2 text-term-muted">
            <Database className="h-8 w-8 opacity-40" aria-hidden />
            <p className="text-sm">选择项目与站点后点击「立即生成」，分析结果会实时出现在这里</p>
          </div>
        </TermPanel>
      )}
    </div>
  )
}
