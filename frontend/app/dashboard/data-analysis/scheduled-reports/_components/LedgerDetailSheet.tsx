'use client'

import { useState } from 'react'
import Image from 'next/image'
import { AlertTriangle, Copy, ExternalLink, FileText, ImageIcon } from 'lucide-react'
import { format } from 'date-fns'
import ReactMarkdown from 'react-markdown'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PortraitScreenshotDialog } from '@/components/ui/image-preview-dialog'
import { cn } from '@/lib/utils'
import { getCountryLabel } from '@/lib/country'
import { LedgerResendCell } from './LedgerResendCell'
import { FREQUENCY_LABELS } from './ledger-constants'
import type { AIModelConfig, LedgerItem, ResendStage, Subscription } from './types'

const HERO_BG: Record<string, string> = {
  sent: 'bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-950/30 dark:to-background border-emerald-200 dark:border-emerald-800',
  failed: 'bg-gradient-to-br from-red-50 to-white dark:from-red-950/30 dark:to-background border-red-200 dark:border-red-800',
  missing: 'bg-gradient-to-br from-amber-50 to-white dark:from-amber-950/30 dark:to-background border-amber-200 dark:border-amber-800',
}

const HERO_LABEL: Record<string, { text: string; color: string }> = {
  sent: { text: '✓ 发送成功', color: 'text-emerald-700 dark:text-emerald-300' },
  failed: { text: '✗ 发送失败', color: 'text-red-700 dark:text-red-300' },
  missing: { text: '⚠ 记录缺失', color: 'text-amber-700 dark:text-amber-300' },
}

const SECTION_LABEL = 'text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2 block'

const MAX_VISIBLE_PROJECTS = 8

interface LedgerDetailSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: LedgerItem | null
  subscriptions: Subscription[]
  modelConfig: AIModelConfig | null
  isLoadingModelConfig: boolean
  resendingStage: ResendStage | undefined
  canTriggerResend: boolean
  onResend: (item: LedgerItem, overrideAiModel: string | null) => void
  onResendLoading: (item: LedgerItem) => void
  onCopy: (text: string) => void
}

export function LedgerDetailSheet({
  open,
  onOpenChange,
  item,
  subscriptions,
  modelConfig,
  isLoadingModelConfig,
  resendingStage,
  canTriggerResend,
  onResend,
  onResendLoading,
  onCopy,
}: LedgerDetailSheetProps) {
  const [previewScreenshot, setPreviewScreenshot] = useState<string | null>(null)
  const [showAllProjects, setShowAllProjects] = useState(false)

  const sub = item ? subscriptions.find(s => s.id === item.subscription_id) : undefined
  const fallbackModel = item ? (sub?.ai_model || modelConfig?.defaultModel || '') : ''
  const canTrigger = !!item && (canTriggerResend || item.can_resend)

  const projectNames = !item
    ? []
    : item.project_names?.length > 0
      ? item.project_names
      : item.project_ids === '*'
        ? ['全部项目']
        : item.project_ids.split(',').filter(Boolean)
  const countryList = !item ? [] : item.country.split(',').map(c => c.trim()).filter(Boolean)
  const visibleProjects = showAllProjects ? projectNames : projectNames.slice(0, MAX_VISIBLE_PROJECTS)
  const hiddenCount = projectNames.length - visibleProjects.length

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          className={cn(
            'sm:max-w-md w-full p-0 flex flex-col gap-0',
            'border-l border-border/60',
          )}
        >
          {item ? (
            <>
              <SheetHeader
                className={cn(
                  'border-b px-5 py-4 space-y-1.5',
                  HERO_BG[item.status],
                )}
              >
                <div className={cn('text-[11px] font-medium tracking-wide flex items-center gap-1.5', HERO_LABEL[item.status].color)}>
                  {item.status === 'missing' && <AlertTriangle className="h-3 w-3" />}
                  {HERO_LABEL[item.status].text}
                </div>
                <SheetTitle className="text-xl font-semibold tracking-tight">
                  {format(new Date(item.expected_at), 'yyyy-MM-dd · HH:mm')}
                </SheetTitle>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>📨 {item.email}</span>
                  <span>{FREQUENCY_LABELS[item.frequency]}</span>
                  {countryList.length > 0 && <span>{countryList.map(getCountryLabel).join(' · ')}</span>}
                </div>
              </SheetHeader>

              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
                {item.status === 'failed' && item.error_message && (
                  <div>
                    <span className={SECTION_LABEL}>错误信息</span>
                    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-xs text-red-700 whitespace-pre-wrap dark:bg-red-950/30 dark:border-red-800 dark:text-red-300">
                      {item.error_message}
                    </div>
                  </div>
                )}

                <div>
                  <span className={SECTION_LABEL}>报告范围</span>
                  <div className="flex flex-wrap gap-1.5">
                    {visibleProjects.map((name, idx) => (
                      <Badge
                        key={`${name}-${idx}`}
                        variant="secondary"
                        className="bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-50 text-[11px] dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800"
                      >
                        {name}
                      </Badge>
                    ))}
                    {hiddenCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowAllProjects(true)}
                        className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                      >
                        +{hiddenCount} 更多
                      </button>
                    )}
                    {showAllProjects && projectNames.length > MAX_VISIBLE_PROJECTS && (
                      <button
                        type="button"
                        onClick={() => setShowAllProjects(false)}
                        className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                      >
                        收起
                      </button>
                    )}
                  </div>
                  {countryList.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {countryList.map(c => (
                        <Badge key={c} variant="outline" className="text-[11px]">
                          {getCountryLabel(c)}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <span className={SECTION_LABEL}>报告截图</span>
                    {item.screenshot_r2_url ? (
                      <button
                        type="button"
                        onClick={() => setPreviewScreenshot(item.screenshot_r2_url)}
                        className="group relative w-full aspect-[3/4] overflow-hidden rounded-lg border border-border/70 hover:ring-2 hover:ring-primary/50 transition-shadow"
                      >
                        <Image
                          src={item.screenshot_r2_thumb_url || item.screenshot_r2_url}
                          alt="报告截图"
                          fill
                          className="object-contain bg-muted/30"
                          unoptimized
                        />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors flex items-center justify-center">
                          <ExternalLink className="h-5 w-5 text-white/0 group-hover:text-white/70 transition-colors" />
                        </div>
                      </button>
                    ) : (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-6 border border-dashed border-border/50 justify-center">
                        <ImageIcon className="h-4 w-4" />
                        暂无截图
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className={cn(SECTION_LABEL, 'mb-0')}>AI 文案</span>
                      {item.ai_summary && (
                        <button
                          type="button"
                          onClick={() => onCopy(item.ai_summary!.replace(/^[-•·●]\s*/gm, '◉ '))}
                          className="flex items-center gap-1 text-[11px] text-blue-600 hover:underline dark:text-blue-400"
                          aria-label="复制 AI 文案"
                        >
                          <Copy className="h-3 w-3" />
                          复制
                        </button>
                      )}
                    </div>
                    {item.ai_summary ? (
                      <div className="rounded-lg border border-border/60 bg-muted/20 overflow-hidden">
                        <div className="h-[200px] overflow-y-auto p-3 text-xs leading-relaxed
                          prose prose-xs prose-neutral dark:prose-invert max-w-none
                          [&_ul]:my-0.5 [&_p]:my-0.5 [&_strong]:font-semibold"
                        >
                          <ReactMarkdown>
                            {item.ai_summary.replace(/^[•·●]\s*/gm, '- ')}
                          </ReactMarkdown>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 rounded-lg px-3 py-6 border border-dashed border-border/50 justify-center h-[200px]">
                        <FileText className="h-4 w-4" />
                        暂无 AI 文案
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {canTrigger && item && (
            <div className="sticky bottom-0 border-t border-border/60 bg-background px-5 py-3 flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <LedgerResendCell
                item={item}
                resendingStage={resendingStage}
                canResend
                modelConfig={modelConfig}
                isLoadingModelConfig={isLoadingModelConfig}
                fallbackModel={fallbackModel}
                onLoading={() => onResendLoading(item)}
                onSubmit={(overrideAiModel) => {
                  onResend(item, overrideAiModel)
                  onOpenChange(false)
                }}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>

      {previewScreenshot && (
        <PortraitScreenshotDialog
          open
          onOpenChange={o => !o && setPreviewScreenshot(null)}
          src={previewScreenshot}
          alt="报告截图"
        />
      )}
    </>
  )
}
