'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
  Bot,
  Check,
  Copy,
  Loader2,
  Sparkles,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

type InsightStatus =
  | 'idle'
  | 'pending'
  | 'data_aggregating'
  | 'generating'
  | 'ai_generating'
  | 'title_generating'
  | 'completed'
  | 'failed'

const SUB_STATUS_LABEL: Record<string, string> = {
  data_aggregating: '正在聚合 10 种广告数据 + 销售 + 库存...',
  data_aggregating_sales: '抓取销售数据...',
  data_aggregating_ad: '抓取广告数据...',
  data_aggregating_inventory: '抓取库存数据...',
  data_aggregating_comparison_sales: '抓取对比期销售...',
  data_aggregating_comparison_ad: '抓取对比期广告...',
  data_aggregating_top_skus: '抓取 Top SKU...',
  data_aggregating_ad_campaigns: '抓取广告活动...',
  data_aggregating_ad_ad_promoted_product_report: '聚合商品推广数据...',
  data_aggregating_ad_ad_campaign_report: '聚合广告活动数据...',
  data_aggregating_ad_ad_search_term_report: '聚合搜索词数据...',
  data_aggregating_ad_ad_target_report: '聚合投放数据...',
  data_aggregating_ad_ad_placement_report: '聚合广告位数据...',
  data_aggregating_ad_ad_budget_report: '聚合预算数据...',
  data_aggregating_ad_ad_invalid_traffic_report: '聚合无效流量数据...',
  data_aggregating_ad_ad_time_trend_report: '聚合并时间效果数据...',
  data_aggregating_ad_ad_search_term_share_report: '聚合搜索词展示量份额...',
  data_aggregating_ad_ad_purchased_product_report: '聚合已购买商品数据...',
  // Agent Pipeline 阶段标签
  agent_profiling: '📊 正在分析数据质量与信号强度...',
  agent_planning: '🎯 正在规划分析策略...',
  agent_assembling: '🔧 正在组装分析指令...',
  agent_generating: '🤖 AI Agent 分析中...',
  agent_evolving: '📝 正在记录分析结果...',
  // Multi-pass stages
  agent_pass_1: '🔍 Pass 1: 侦察扫描中...',
  agent_pass_2: '🎯 Pass 2: 深度分析中...',
  agent_pass_3: '📋 Pass 3: 综合报告中...',
  ai_generating: 'AI 分析中（双角色：运营 + 广告优化）...',
  title_generating: '正在生成标题...',
}

function formatYMD(d: Date | undefined | null): string {
  if (!d) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

interface GenerationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: number | null
  country: string
  dateRange: { from: Date; to: Date }
  onComplete?: () => void
}

export function GenerationDialog({
  open,
  onOpenChange,
  projectId,
  country,
  dateRange,
  onComplete,
}: GenerationDialogProps) {
  const [status, setStatus] = useState<InsightStatus>('idle')
  const [subStatus, setSubStatus] = useState<string | null>(null)
  const [streamedContent, setStreamedContent] = useState('')
  const [finalTitle, setFinalTitle] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [agentStage, setAgentStage] = useState<string | null>(null)
  const [agentStageData, setAgentStageData] = useState<any>(null)
  const [passMode, setPassMode] = useState<string | null>(null)
  const [currentPass, setCurrentPass] = useState<number>(0)
  const [hotspots, setHotspots] = useState<any[] | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const startedRef = useRef(false)

  const startDate = formatYMD(dateRange.from)
  const endDate = formatYMD(dateRange.to)

  const isRunning = ['pending', 'data_aggregating', 'generating', 'ai_generating', 'title_generating'].includes(status)

  const startGeneration = useCallback(async () => {
    if (!projectId || !startDate || !endDate) return

    setStreamedContent('')
    setFinalTitle(null)
    setErrorMessage(null)
    setStatus('pending')
    setSubStatus('queued')

    try {
      const res = await fetch('/api/backend/v1/ai-insights/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          country,
          date_range_start: startDate,
          date_range_end: endDate,
          insight_type: 'ad_analysis',
        }),
      })
      if (!res.ok) {
        const errText = await res.text()
        throw new Error(`生成请求失败: ${res.status} ${errText}`)
      }
      const data = await res.json()
      const insightId = data.insight_id as number | undefined
      if (!insightId) throw new Error('未返回 insight_id')

      setStatus('data_aggregating')
      setSubStatus('data_aggregating')

      const es = new EventSource(
        `/api/backend/v1/ai-insights/${insightId}/stream`,
        { withCredentials: true } as any,
      )
      esRef.current = es

      es.addEventListener('message', (e: MessageEvent) => {
        try {
          const payload = JSON.parse(e.data)
          if (payload.type === 'status') {
            setStatus(payload.status ?? 'idle')
            setSubStatus(payload.sub_status ?? null)
          } else if (payload.type === 'agent_stage') {
            // Agent Pipeline 阶段事件 — 记录当前阶段和数据
            const stage = payload.stage ?? null
            setAgentStage(stage)
            if (payload.data) setAgentStageData(payload.data)
            if (payload.text) setAgentStageData({ declaration: payload.text })
            // 多轮分析阶段追踪
            if (stage === 'pass_mode') {
              setPassMode(payload.text ?? payload.data?.mode ?? null)
            } else if (stage?.startsWith('pass_')) {
              const passNum = parseInt(stage.replace('pass_', ''), 10)
              if (!isNaN(passNum)) setCurrentPass(passNum)
            } else if (stage === 'hotspots' && Array.isArray(payload.data)) {
              setHotspots(payload.data)
            }
          } else if (payload.type === 'chunk' && payload.delta) {
            setStatus('ai_generating')
            setSubStatus('ai_generating')
            setStreamedContent((prev) => prev + payload.delta)
          } else if (payload.type === 'done') {
            if (payload.title) setFinalTitle(payload.title)
            if (payload.content) setStreamedContent(payload.content)
            setStatus('completed')
            setSubStatus(null)
            es.close()
            esRef.current = null
            onComplete?.()
          } else if (payload.type === 'error') {
            setStatus('failed')
            setErrorMessage(payload.error || payload.error_message || '生成失败')
            es.close()
            esRef.current = null
          }
        } catch {
          // ignore parse error
        }
      })

      es.addEventListener('error', () => {
        setStatus((s) => (s === 'completed' ? s : 'failed'))
        setErrorMessage((prev) => prev ?? '流式连接中断')
        es.close()
        esRef.current = null
      })
    } catch (err) {
      setStatus('failed')
      setErrorMessage(String(err))
    }
  }, [projectId, country, startDate, endDate, onComplete])

  useEffect(() => {
    if (open && !startedRef.current) {
      startedRef.current = true
      startGeneration()
    }
    if (!open) {
      startedRef.current = false
      if (esRef.current) {
        esRef.current.close()
        esRef.current = null
      }
    }
  }, [open, startGeneration])

  useEffect(() => {
    return () => {
      if (esRef.current) {
        esRef.current.close()
        esRef.current = null
      }
    }
  }, [])

  const handleCopy = useCallback(async () => {
    if (!streamedContent) return
    try {
      await navigator.clipboard.writeText(streamedContent)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // ignore
    }
  }, [streamedContent])

  const canClose = !isRunning

  return (
    <Dialog open={open} onOpenChange={canClose ? onOpenChange : undefined}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              {finalTitle ?? '正在生成广告分析报告'}
            </DialogTitle>
            <div className="flex items-center gap-2">
              {streamedContent && (
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
              )}
              {canClose && (
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onOpenChange(false)}>
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {startDate} ~ {endDate}
          </p>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-1">
          {/* Status banner */}
          {isRunning && (
            <div className="mb-4 space-y-2">
              <div className="flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span className="text-sm text-primary">
                  {subStatus && SUB_STATUS_LABEL[subStatus] ? SUB_STATUS_LABEL[subStatus] : '处理中...'}
                </span>
              </div>
              {/* Agent stage indicator */}
              {agentStage && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground pl-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                  {agentStage === 'profile' && 'Layer 0: 数据探针完成'}
                  {agentStage === 'strategy' && 'Layer 1: 策略规划完成'}
                  {agentStage === 'declaration' && 'Layer 2: Prompt 组装完成 → AI 生成中'}
                  {agentStage === 'pass_mode' && `分析模式: ${passMode === '多轮分析' ? 'Scout → Deep-dive → Synthesis' : '单轮分析'}`}
                  {agentStage === 'pass_1' && '🔍 Pass 1: 侦察扫描 — 识别热点问题...'}
                  {agentStage === 'pass_2' && `🎯 Pass 2: 深度分析 — 正在深挖第 ${currentPass} 个热点...`}
                  {agentStage === 'pass_3' && '📋 Pass 3: 综合报告 — 整合交叉分析...'}
                  {agentStage === 'hotspots' && hotspots && (
                    <span>发现 {hotspots.length} 个热点: {hotspots.map(h => h.finding).join('、')}</span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Agent strategy summary (shown after strategy stage, before/during content) */}
          {agentStageData?.primary_dimensions && (
            <div className="mb-3 rounded-md border bg-muted/30 px-3 py-2">
              <p className="text-xs font-medium text-muted-foreground mb-1.5">
                分析策略：覆盖 {agentStageData.primary_dimensions?.length ?? 0} 个单维度
                {agentStageData.cross_analyses?.length ? `、${agentStageData.cross_analyses.length} 个交叉分析` : ''}
                {agentStageData.temporal_analyses?.length ? `、${agentStageData.temporal_analyses.length} 个跨周期分析` : ''}
                {agentStageData.skipped?.length ? `，跳过 ${agentStageData.skipped.length} 个` : ''}
              </p>
              <div className="flex flex-wrap gap-1">
                {agentStageData.primary_dimensions?.map((d: any) => (
                  <span key={d.dimension_id} className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                    L1 {d.name}
                  </span>
                ))}
                {agentStageData.cross_analyses?.map((d: any) => (
                  <span key={d.dimension_id} className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                    L2 {d.name}
                  </span>
                ))}
                {agentStageData.temporal_analyses?.map((d: any) => (
                  <span key={d.dimension_id} className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
                    L3 {d.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Hotspots display (shown after Scout pass identifies issues) */}
          {hotspots && hotspots.length > 0 && !streamedContent && (
            <div className="mb-3 rounded-md border bg-amber-50/50 dark:bg-amber-950/20 px-3 py-2">
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400 mb-1.5">
                🔍 侦察发现 {hotspots.length} 个热点问题
              </p>
              <div className="space-y-1">
                {hotspots.map((h: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className={cn(
                      'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                      h.severity === 'high'
                        ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
                    )}>
                      {h.severity === 'high' ? '高' : '中'}
                    </span>
                    <span className="font-medium">{h.finding}</span>
                    {h.key_metric && (
                      <span className="text-muted-foreground ml-auto">{h.key_metric}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {status === 'failed' && errorMessage && (
            <div className="mb-4 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <span className="text-sm text-destructive">生成失败: {errorMessage}</span>
            </div>
          )}

          {!streamedContent && !isRunning && status !== 'failed' && (
            <div className="flex min-h-[200px] flex-col items-center justify-center text-center text-sm text-muted-foreground">
              <Bot className="mb-3 h-10 w-10 opacity-30" />
              <p>正在准备生成...</p>
            </div>
          )}

          {streamedContent && (
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
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamedContent}</ReactMarkdown>
              </div>
              {isRunning && (
                <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                  Markdown 实时渲染中
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
