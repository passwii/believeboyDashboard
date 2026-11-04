'use client'

import { useMemo } from 'react'
import { Check, ChevronsUpDown, Loader2, Mail, CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TimePicker } from '@/components/ui/time-picker'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { cn } from '@/lib/utils'
import { getCountryLabel, COUNTRY_OPTIONS } from '@/lib/country'
import { ProjectScopeSelect } from '@/components/project-scope-select'
import type { AIModelConfig, Frequency } from './types'
import { MIN_HOUR_FOR_MONDAY, WEEKDAY_LABELS } from './types'
import { AiModelOptions } from './ai-model-options'
import styles from '../scheduled-reports-warm.module.css'

interface Props {
  mode: 'create' | 'edit'
  editingSub?: unknown
  formEmail: string
  setFormEmail: (v: string) => void
  formProjectIds: string
  setFormProjectIds: (v: string) => void
  formSelectedProjectIds: string[]
  setFormSelectedProjectIds: (ids: string[]) => void
  formCountries: string[]
  setFormCountries: (v: string[]) => void
  formFrequency: Frequency
  setFormFrequency: (v: Frequency) => void
  formDispatchHour: number
  setFormDispatchHour: (v: number) => void
  formDispatchMinute: number
  setFormDispatchMinute: (v: number) => void
  formDispatchWeekday: number
  setFormDispatchWeekday: (v: number) => void
  formDispatchDay: number
  setFormDispatchDay: (v: number) => void
  formAiModel: string
  setFormAiModel: (v: string) => void
  projects: Array<{ id?: number | null; name: string }>
  modelConfig: AIModelConfig | null
  isLoadingModelConfig: boolean
  formError: string | null
  testResult: { success: boolean; message: string } | null
  formSubmitting: boolean
  testingEmail: boolean
  onTestEmail: () => void
  onSubmit: () => void
  onCancel: () => void
}

export function SubscriptionForm({
  mode,
  formEmail,
  setFormEmail,
  formProjectIds,
  setFormProjectIds,
  formSelectedProjectIds,
  setFormSelectedProjectIds,
  formCountries,
  setFormCountries,
  formFrequency,
  setFormFrequency,
  formDispatchHour,
  setFormDispatchHour,
  formDispatchMinute,
  setFormDispatchMinute,
  formDispatchWeekday,
  setFormDispatchWeekday,
  formDispatchDay,
  setFormDispatchDay,
  formAiModel,
  setFormAiModel,
  projects,
  modelConfig,
  isLoadingModelConfig,
  formError,
  testResult,
  formSubmitting,
  testingEmail,
  onTestEmail,
  onSubmit,
  onCancel,
}: Props) {
  const allowedHourOptions = useMemo(() => {
    if (formFrequency !== 'weekly' || formDispatchWeekday !== 0) {
      return Array.from({ length: 24 }, (_, i) => i)
    }
    return Array.from({ length: 8 }, (_, i) => i + MIN_HOUR_FOR_MONDAY)
  }, [formFrequency, formDispatchWeekday])

  const isMondayRestricted = formFrequency === 'weekly' && formDispatchWeekday === 0

  // 配置预览文本
  const configPreview = useMemo(() => {
    const parts: string[] = [formEmail || '未填写邮箱']
    parts.push(FREQUENCY_LABEL[formFrequency])
    const timeStr = `${String(formDispatchHour).padStart(2, '0')}:${String(formDispatchMinute).padStart(2, '0')}`
    if (formFrequency === 'weekly') {
      parts.push(`${WEEKDAY_LABELS[formDispatchWeekday]} ${timeStr}`)
    } else if (formFrequency === 'monthly') {
      parts.push(`每月${formDispatchDay}日 ${timeStr}`)
    } else {
      parts.push(timeStr)
    }
    if (formCountries.length > 0) {
      parts.push(formCountries.map((c) => getCountryLabel(c)).join(','))
    }
    if (formAiModel) parts.push(formAiModel)
    return parts.join(' · ')
  }, [
    formEmail,
    formFrequency,
    formDispatchHour,
    formDispatchMinute,
    formDispatchWeekday,
    formDispatchDay,
    formCountries,
    formAiModel,
  ])

  return (
    // 三段默认全开后表单明显变高：把标题与「配置预览 + 操作按钮」固定在两端，
    // 只让中间的折叠区滚动，底部按钮不会被顶到滚动边缘、在手机上也不用翻到底才能提交。
    <div className={styles.form} data-testid="subscription-form" data-warm-ledger-form="true">
      {/* 标题区 */}
      <div className={styles.formHeader}>
        <h2 className={styles.formTitle}>{mode === 'create' ? '新增订阅' : '编辑订阅'}</h2>
        <p className={styles.formDescription}>
          {mode === 'create' ? '配置自动报告的接收邮箱、频率和内容范围' : '修改订阅配置'}
        </p>
      </div>

      {/* 三段默认全开（BLF-1032）：模型选择此前默认折叠，每次改模型都要先点一次
          展开，是高频操作路径上的固定损耗。 */}
      <Accordion
        type="multiple"
        defaultValue={['basic', 'scope', 'ai']}
        className={styles.accordion}
      >
        {/* ── 基础设置 ── */}
        <AccordionItem value="basic" className={styles.accordionItem}>
          <AccordionTrigger className={styles.accordionTrigger}>
            基础设置
          </AccordionTrigger>
          <AccordionContent className="pb-4">
            <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
              {/* 邮箱 + 测试按钮 inline */}
              <div className="md:col-span-2">
                <label className="text-sm font-medium mb-1.5 block">
                  邮箱地址
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    （可选，留空仅生成报告不发送邮件）
                  </span>
                </label>
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <Input
                      type="email"
                      placeholder="ops@company.com"
                      value={formEmail}
                      onChange={(e) => setFormEmail(e.target.value)}
                      className={cn(
                        styles.input,
                        formEmail &&
                          'border-[color:var(--warm-ledger-color-positive)]'
                      )}
                    />
                    {formEmail && (
                      <CheckCircle2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--warm-ledger-color-positive)]" />
                    )}
                  </div>
                  <Button
                    size="sm"
                    onClick={onTestEmail}
                    disabled={testingEmail || !formEmail}
                    title="发送测试邮件到该地址"
                    className={cn(styles.button, 'shrink-0')}
                  >
                    {testingEmail ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Mail className="h-4 w-4" />
                    )}
                    <span className="hidden sm:inline ml-1.5">测试</span>
                  </Button>
                </div>
                {/* 测试结果反馈 */}
                {testResult && (
                  <div
                    className={cn(
                      'mt-1.5 flex items-center gap-1.5 text-xs',
                      testResult.success
                        ? 'text-[color:var(--warm-ledger-color-positive)]'
                        : 'text-[color:var(--warm-ledger-color-negative)]'
                    )}
                  >
                    {testResult.success ? (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5" />
                    )}
                    {testResult.message}
                  </div>
                )}
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">推送频率</label>
                <Select
                  value={formFrequency}
                  onValueChange={(v) => {
                    const newFreq = v as Frequency
                    setFormFrequency(newFreq)
                    if (
                      newFreq === 'weekly' &&
                      formDispatchWeekday === 0 &&
                      formDispatchHour < 16
                    ) {
                      setFormDispatchHour(16)
                    }
                  }}
                >
                  <SelectTrigger className={styles.control}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className={styles.selectContent}>
                    <SelectItem value="daily" className={styles.selectItem}>每日</SelectItem>
                    <SelectItem value="weekly" className={styles.selectItem}>每周</SelectItem>
                    <SelectItem value="monthly" className={styles.selectItem}>每月</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">
                  发送时间（北京时间）
                  {isMondayRestricted && (
                    <span className="ml-1.5 text-xs text-[color:var(--warm-ledger-color-accent)] font-normal">
                      （周一 ≥ 16:00）
                    </span>
                  )}
                </label>
                <TimePicker
                  hour={formDispatchHour}
                  minute={formDispatchMinute}
                  onHourChange={setFormDispatchHour}
                  onMinuteChange={setFormDispatchMinute}
                  allowedHours={allowedHourOptions}
                />
              </div>
              {formFrequency === 'weekly' && (
                <div>
                  <label className="text-sm font-medium mb-1.5 block">发送星期</label>
                  <Select
                    value={String(formDispatchWeekday)}
                    onValueChange={(v) => {
                      const newWeekday = Number(v)
                      setFormDispatchWeekday(newWeekday)
                      if (newWeekday === 0 && formDispatchHour < 16) setFormDispatchHour(16)
                    }}
                  >
                    <SelectTrigger className={styles.control}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className={styles.selectContent}>
                      {WEEKDAY_LABELS.map((label, i) => (
                        <SelectItem key={i} value={String(i)} className={styles.selectItem}>
                          {i === 0 ? `${label}（最早 16:00）` : label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {formFrequency === 'monthly' && (
                <div>
                  <label className="text-sm font-medium mb-1.5 block">发送日期</label>
                  <Select
                    value={String(formDispatchDay)}
                    onValueChange={(v) => setFormDispatchDay(Number(v))}
                  >
                    <SelectTrigger className={styles.control}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className={cn(styles.selectContent, 'max-h-[240px]')}>
                      {Array.from({ length: 27 }, (_, i) => (
                        <SelectItem key={i + 2} value={String(i + 2)} className={styles.selectItem}>
                          {i + 2} 日
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* ── 范围设置 ── */}
        <AccordionItem value="scope" className={styles.accordionItem}>
          <AccordionTrigger className={styles.accordionTrigger}>
            范围设置
          </AccordionTrigger>
          <AccordionContent className="pb-4">
            <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
              <div>
                <label className="text-sm font-medium mb-1.5 block">
                  国家站点
                  {formCountries.length > 1 && (
                    <span className="ml-1.5 text-xs font-normal text-[color:var(--warm-ledger-color-accent-strong)]">
                      （{formCountries.length} 个站点合并报告）
                    </span>
                  )}
                </label>
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(styles.control, 'w-full justify-between')}
                    >
                      <span className="truncate">
                        {formCountries.length === 0
                          ? '选择国家...'
                          : formCountries.map((c) => getCountryLabel(c)).join(', ')}
                      </span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className={styles.popoverContent} align="start">
                    <div className="space-y-1 max-h-[240px] overflow-y-auto">
                      {COUNTRY_OPTIONS.map((opt) => {
                        const selected = formCountries.includes(opt.value)
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            className={cn(
                              'flex w-full items-center gap-2 rounded-[var(--warm-ledger-radius-inner)] px-2 py-1.5 text-sm hover:bg-[var(--warm-ledger-color-raised-hover)] transition-colors',
                              selected && 'bg-[var(--warm-ledger-color-accent-soft)]'
                            )}
                            onClick={() => {
                              if (selected) {
                                setFormCountries(formCountries.filter((c) => c !== opt.value))
                              } else {
                                setFormCountries([...formCountries, opt.value])
                              }
                            }}
                          >
                            <div
                              className={cn(
                                'flex h-4 w-4 items-center justify-center rounded-[var(--warm-ledger-radius-inner)] border-[color:var(--warm-ledger-color-hairline-strong)]',
                                selected
                                  ? 'border-[color:var(--warm-ledger-color-accent)] bg-[var(--warm-ledger-color-accent)] text-[var(--warm-ledger-color-window)]'
                                  : 'border-input'
                              )}
                            >
                              {selected && <Check className="h-3 w-3" />}
                            </div>
                            <span>{opt.label}</span>
                          </button>
                        )
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">项目范围</label>
                <ProjectScopeSelect
                  value={formProjectIds}
                  selectedIds={formSelectedProjectIds}
                  onValueChange={setFormProjectIds}
                  onSelectedIdsChange={setFormSelectedProjectIds}
                  projects={projects}
                />
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* ── AI 模型 ── */}
        <AccordionItem value="ai" className={styles.accordionItem}>
          <AccordionTrigger className={styles.accordionTrigger}>
            AI 模型
            {formAiModel && (
              <span className="ml-auto mr-2 text-xs text-muted-foreground font-normal truncate max-w-[150px]">
                {formAiModel}
              </span>
            )}
          </AccordionTrigger>
          <AccordionContent className="pb-4">
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium mb-1.5 block">选择模型</label>
                <Select
                  value={formAiModel}
                  onValueChange={setFormAiModel}
                  disabled={isLoadingModelConfig || !modelConfig?.models.length}
                >
                  <SelectTrigger className={styles.control} aria-label="选择 AI 模型">
                    <SelectValue
                      placeholder={isLoadingModelConfig ? '加载模型中...' : '选择模型'}
                    />
                  </SelectTrigger>
                  <SelectContent className={styles.selectContent}>
                    <AiModelOptions config={modelConfig} />
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                选择用于生成报告摘要的 AI 模型。高级模型质量更好但速度较慢。
              </p>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      {/* 全局错误 */}
      {formError && (
        <div className={styles.formError}>
          <XCircle className="h-4 w-4 shrink-0" />
          {formError}
        </div>
      )}

      {/* 配置预览 */}
      <div className={styles.preview}>
        <div className={styles.previewLabel}>配置预览</div>
        <div className={styles.previewValue} title={configPreview}>
          {configPreview}
        </div>
      </div>

      {/* 操作按钮 */}
      <div className={styles.formFooter}>
        <Button onClick={onCancel} className={cn(styles.button, 'order-2 sm:order-1')}>
          取消
        </Button>
        <div className={styles.formFooterSpacer} />
        <Button
          onClick={onSubmit}
          disabled={formSubmitting}
          className={cn(styles.buttonPrimary, 'order-1 sm:order-3')}
        >
          {formSubmitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {mode === 'create' ? '确认创建' : '保存修改'}
        </Button>
      </div>
    </div>
  )
}

const FREQUENCY_LABEL: Record<Frequency, string> = {
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
}
