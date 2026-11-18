'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, CheckCircle2, Mail, Plus, X, XCircle } from 'lucide-react'
import {
  WarmButton,
  WarmSegmentedControl,
  WarmSelect,
  type WarmSelectOption,
} from '@/components/dashboard-v2/warm-ledger/controls/warm-controls'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { getCountryLabel, COUNTRY_OPTIONS } from '@/lib/country'
import type { AIModelConfig, Frequency } from './types'
import { MIN_HOUR_FOR_MONDAY, WEEKDAY_LABELS } from './types'
import styles from './subscription-dialog-warm.module.css'

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

/** 前端只拦「非空且明显不完整」的邮箱；空值表示仅生成不发送，必须放行。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EMAIL_ERROR_TEXT = '邮箱格式无效，请输入完整邮箱地址'

export function isValidSubscriptionEmail(value: string | null | undefined): boolean {
  const email = value?.trim() ?? ''
  return email === '' || EMAIL_PATTERN.test(email)
}

export function subscriptionEmailError(value: string | null | undefined): string | null {
  const email = value?.trim() ?? ''
  if (!email) return null
  return isValidSubscriptionEmail(email) ? null : EMAIL_ERROR_TEXT
}

/** 国家站点至少保留 1 个，避免空列表被后端静默回退成默认站点。 */
export function subscriptionCountryError(countries: readonly string[]): string | null {
  return countries.length === 0 ? '请至少保留 1 个站点' : null
}

/**
 * 「指定项目」必须真的选中项目；否则 `project_ids` 为空串会在提交处
 * 被归一成 '*'（全部项目），用户选的「指定」会静默变成「全部」。
 */
export function subscriptionProjectError(
  projectIds: string,
  selectedProjectIds: readonly string[]
): string | null {
  if (projectIds === '*' || selectedProjectIds.length > 0) return null
  return '请至少选择 1 个项目'
}

const FREQUENCY_OPTIONS: ReadonlyArray<{ value: Frequency; label: string }> = [
  { value: 'daily', label: '每日' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
]

const PROJECT_SCOPE_OPTIONS = [
  { value: 'all', label: '全部项目' },
  { value: 'specific', label: '指定项目' },
] as const

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * premium → basic → 其余模型，压平成一个 WarmSelect 选项列表。
 * 保留原分组顺序，不渲染分组标题（WarmSelect 不支持分组，逐项平铺即可）。
 */
function flattenModelOptions(
  config: AIModelConfig | null,
  currentModel: string
): WarmSelectOption[] {
  const models = config?.models ?? []
  const premium = config?.premiumModels ?? []
  const basic = config?.basicModels ?? []
  const others = models.filter((model) => !premium.includes(model) && !basic.includes(model))
  const ordered = [...premium, ...basic, ...others]
  const seen = new Set<string>()
  const options: WarmSelectOption[] = []
  for (const model of ordered) {
    if (!model || seen.has(model)) continue
    seen.add(model)
    options.push({ value: model, label: model })
  }
  // 历史订阅可能引用了已下线的模型：保留可读文案，避免编辑时下拉显示空白。
  if (currentModel && !seen.has(currentModel)) {
    options.push({ value: currentModel, label: currentModel })
  }
  return options
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
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

  const emailError = subscriptionEmailError(formEmail)
  const emailTrimmed = formEmail.trim()
  const canTestEmail = Boolean(emailTrimmed) && !emailError

  const allowedHourOptions = useMemo(() => {
    if (formFrequency !== 'weekly' || formDispatchWeekday !== 0) {
      return Array.from({ length: 24 }, (_, i) => i)
    }
    return Array.from({ length: 8 }, (_, i) => i + MIN_HOUR_FOR_MONDAY)
  }, [formFrequency, formDispatchWeekday])

  const hourOptions = useMemo<WarmSelectOption[]>(() => {
    const hours = allowedHourOptions.includes(formDispatchHour)
      ? allowedHourOptions
      : [formDispatchHour, ...allowedHourOptions]
    return hours.map((hour) => ({ value: String(hour), label: pad(hour) }))
  }, [allowedHourOptions, formDispatchHour])

  const minuteOptions = useMemo<WarmSelectOption[]>(
    () =>
      Array.from({ length: 60 }, (_, minute) => ({
        value: String(minute),
        label: pad(minute),
      })),
    []
  )

  const weekdayOptions = useMemo<WarmSelectOption[]>(
    () =>
      WEEKDAY_LABELS.map((label, index) => ({
        value: String(index),
        label: index === 0 ? `${label}（最早 16:00）` : label,
      })),
    []
  )

  const dayOptions = useMemo<WarmSelectOption[]>(() => {
    const days = Array.from({ length: 27 }, (_, i) => i + 2)
    const values = days.includes(formDispatchDay)
      ? days
      : [formDispatchDay, ...days]
    return values.map((day) => ({ value: String(day), label: `${day} 日` }))
  }, [formDispatchDay])

  const modelOptions = useMemo(
    () => flattenModelOptions(modelConfig, formAiModel),
    [modelConfig, formAiModel]
  )

  const isMondayRestricted = formFrequency === 'weekly' && formDispatchWeekday === 0
  const projectScope = formProjectIds === '*' ? 'all' : 'specific'
  const countryError = subscriptionCountryError(formCountries)
  const projectError = subscriptionProjectError(formProjectIds, formSelectedProjectIds)
  const validationCount = [emailError, countryError, projectError].filter(Boolean).length

  const handleFrequencyChange = (value: Frequency) => {
    setFormFrequency(value)
    if (value === 'weekly' && formDispatchWeekday === 0 && formDispatchHour < MIN_HOUR_FOR_MONDAY) {
      setFormDispatchHour(MIN_HOUR_FOR_MONDAY)
    }
  }

  const handleWeekdayChange = (value: string) => {
    const weekday = Number(value)
    setFormDispatchWeekday(weekday)
    if (weekday === 0 && formDispatchHour < MIN_HOUR_FOR_MONDAY) {
      setFormDispatchHour(MIN_HOUR_FOR_MONDAY)
    }
  }

  const toggleCountry = (code: string) => {
    if (formCountries.includes(code)) {
      if (formCountries.length <= 1) return
      setFormCountries(formCountries.filter((item) => item !== code))
      return
    }
    setFormCountries([...formCountries, code])
  }

  const handleProjectScopeChange = (value: 'all' | 'specific') => {
    if (value === 'all') {
      setFormProjectIds('*')
      setFormSelectedProjectIds([])
      return
    }
    setFormProjectIds(formSelectedProjectIds.length > 0 ? formSelectedProjectIds.join(',') : '')
  }

  const toggleProject = (projectId: string) => {
    const next = formSelectedProjectIds.includes(projectId)
      ? formSelectedProjectIds.filter((id) => id !== projectId)
      : [...formSelectedProjectIds, projectId]
    setFormSelectedProjectIds(next)
    setFormProjectIds(next.length > 0 ? next.join(',') : '')
  }

  const projectLabel = (projectId: string) => {
    const found = projects.find((project) => String(project.id) === projectId)
    return found?.name ?? `项目${projectId}`
  }

  const testButtonHint = !emailTrimmed
    ? '请先填写邮箱地址后再发送测试邮件'
    : emailError
      ? '请先修正邮箱格式'
      : '发送测试邮件到该地址'

  const emailDescribedBy = [
    'subscription-email-help',
    emailError ? 'subscription-email-error' : null,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={styles.form}
      data-testid="subscription-form"
      data-warm-ledger-form="true"
    >
      <div className={styles.formBody} data-subscription-form-body="true">
        {/* ── 接收 ── */}
        <section className={styles.section} aria-labelledby="subscription-section-receive">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle} id="subscription-section-receive">
              接收
            </h3>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="subscription-email">
              邮箱地址
            </label>
            <div className={styles.inlineRow}>
              <input
                id="subscription-email"
                className={styles.input}
                type="email"
                placeholder="ops@company.com"
                value={formEmail}
                aria-invalid={emailError ? true : undefined}
                aria-describedby={emailDescribedBy}
                onChange={(event) => setFormEmail(event.target.value)}
              />
              <WarmButton
                variant="secondary"
                className={styles.testButton}
                onClick={onTestEmail}
                disabled={testingEmail || !canTestEmail}
                loading={testingEmail}
                title={testButtonHint}
                aria-describedby="subscription-email-help"
              >
                {testingEmail ? null : <Mail aria-hidden />}
                发送测试邮件
              </WarmButton>
            </div>
            <p className={styles.help} id="subscription-email-help">
              留空时只生成报告，不发送邮件。
            </p>
            {emailError ? (
              <p className={styles.fieldError} id="subscription-email-error" role="alert">
                <span aria-hidden>✗</span>
                <span>{emailError}</span>
              </p>
            ) : null}
            {testResult ? (
              <div
                role={testResult.success ? 'status' : 'alert'}
                aria-atomic="true"
                className={cn(
                  styles.testResult,
                  testResult.success ? styles.testSuccess : styles.testFailure
                )}
              >
                {testResult.success ? (
                  <CheckCircle2 aria-hidden />
                ) : (
                  <XCircle aria-hidden />
                )}
                <span>{testResult.message}</span>
              </div>
            ) : null}
          </div>
        </section>

        {/* ── 范围 ── */}
        <section className={styles.section} aria-labelledby="subscription-section-scope">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle} id="subscription-section-scope">
              范围
            </h3>
          </div>
          <div className={styles.grid2}>
            <div className={styles.field}>
              <span className={styles.label} id="subscription-country-label">
                国家站点
              </span>
              <div
                className={styles.chips}
                role="group"
                aria-labelledby="subscription-country-label"
                aria-describedby={countryError ? 'subscription-country-error' : undefined}
              >
                {formCountries.map((code) => {
                  const label = getCountryLabel(code)
                  return (
                    <span key={code} className={styles.chip}>
                      <span>{label}</span>
                      <button
                        type="button"
                        className={styles.chipRemove}
                        aria-label={`移除${label}`}
                        disabled={formCountries.length <= 1}
                        onClick={() => toggleCountry(code)}
                      >
                        <X aria-hidden />
                      </button>
                    </span>
                  )
                })}
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={styles.chipAdd}
                      aria-label="添加站点"
                    >
                      <Plus aria-hidden />
                      添加站点
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    portalContainer={portalContainer}
                    className={styles.popover}
                    align="start"
                    sideOffset={6}
                  >
                    <div
                      className={styles.popoverList}
                      role="listbox"
                      aria-label="选择国家站点"
                      aria-multiselectable="true"
                    >
                      {COUNTRY_OPTIONS.map((option) => {
                        const selected = formCountries.includes(option.value)
                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={styles.popoverOption}
                            onClick={() => toggleCountry(option.value)}
                          >
                            <span className={styles.popoverCheck} aria-hidden>
                              {selected ? <Check /> : null}
                            </span>
                            <span>{option.label}</span>
                          </button>
                        )
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              </div>
              <p className={styles.help}>至少保留 1 个站点。</p>
              {countryError ? (
                <p className={styles.fieldError} id="subscription-country-error" role="alert">
                  <span aria-hidden>✗</span>
                  <span>{countryError}</span>
                </p>
              ) : null}
            </div>

            <div className={styles.field}>
              <span className={styles.label} id="subscription-project-label">
                项目范围
              </span>
              <WarmSegmentedControl
                value={projectScope}
                options={PROJECT_SCOPE_OPTIONS}
                onChange={handleProjectScopeChange}
                ariaLabel="项目范围"
                className={styles.segmentFull}
              />
              {projectScope === 'specific' ? (
                <div
                  className={cn(styles.chips, styles.chipsTop)}
                  role="group"
                  aria-labelledby="subscription-project-label"
                  aria-describedby={projectError ? 'subscription-project-error' : undefined}
                >
                  {formSelectedProjectIds.map((projectId) => {
                    const label = projectLabel(projectId)
                    return (
                      <span key={projectId} className={styles.chip}>
                        <span>{label}</span>
                        <button
                          type="button"
                          className={styles.chipRemove}
                          aria-label={`移除${label}`}
                          onClick={() => toggleProject(projectId)}
                        >
                          <X aria-hidden />
                        </button>
                      </span>
                    )
                  })}
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className={styles.chipAdd}
                        aria-label="添加项目"
                      >
                        <Plus aria-hidden />
                        添加项目
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      portalContainer={portalContainer}
                      className={styles.popover}
                      align="start"
                      sideOffset={6}
                    >
                      {projects.filter((project) => project.id != null).length > 0 ? (
                        <div
                          className={styles.popoverList}
                          role="listbox"
                          aria-label="选择项目"
                          aria-multiselectable="true"
                        >
                          {projects
                            .filter((project) => project.id != null)
                            .map((project) => {
                              const id = String(project.id)
                              const selected = formSelectedProjectIds.includes(id)
                              return (
                                <button
                                  key={id}
                                  type="button"
                                  role="option"
                                  aria-selected={selected}
                                  className={styles.popoverOption}
                                  onClick={() => toggleProject(id)}
                                >
                                  <span className={styles.popoverCheck} aria-hidden>
                                    {selected ? <Check /> : null}
                                  </span>
                                  <span>{project.name}</span>
                                </button>
                              )
                            })}
                        </div>
                      ) : (
                        <p className={styles.popoverEmpty}>暂无可选项目</p>
                      )}
                    </PopoverContent>
                  </Popover>
                </div>
              ) : null}
              <p className={styles.help}>
                {projectScope === 'all'
                  ? '当前聚合所有项目的数据。'
                  : formSelectedProjectIds.length > 0
                    ? `已选 ${formSelectedProjectIds.length} 个项目合并为一份报告。`
                    : '请选择具体项目。'}
              </p>
              {projectError ? (
                <p className={styles.fieldError} id="subscription-project-error" role="alert">
                  <span aria-hidden>✗</span>
                  <span>{projectError}</span>
                </p>
              ) : null}
            </div>
          </div>
        </section>

        {/* ── 调度 ── */}
        <section className={styles.section} aria-labelledby="subscription-section-schedule">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle} id="subscription-section-schedule">
              调度
            </h3>
            <span className={styles.sectionMeta}>北京时间（Asia/Shanghai）</span>
          </div>
          <div className={styles.scheduleGrid}>
            <div className={styles.field}>
              <span className={styles.label} id="subscription-frequency-label">
                频率
              </span>
              <WarmSegmentedControl
                value={formFrequency}
                options={FREQUENCY_OPTIONS}
                onChange={handleFrequencyChange}
                ariaLabel="频率"
                className={styles.segmentFull}
              />
            </div>

            {formFrequency === 'weekly' ? (
              <div className={styles.field}>
                <span className={styles.label} id="subscription-weekday-label">
                  发送星期
                </span>
                <WarmSelect
                  id="subscription-weekday"
                  hideLabel
                  ariaLabel="发送星期"
                  value={String(formDispatchWeekday)}
                  options={weekdayOptions}
                  onChange={handleWeekdayChange}
                />
                {isMondayRestricted ? (
                  <p className={styles.help}>周报最早可在周一 16:00 发送。</p>
                ) : null}
              </div>
            ) : null}

            {formFrequency === 'monthly' ? (
              <div className={styles.field}>
                <span className={styles.label} id="subscription-day-label">
                  发送日期
                </span>
                <WarmSelect
                  id="subscription-day"
                  hideLabel
                  ariaLabel="发送日期"
                  value={String(formDispatchDay)}
                  options={dayOptions}
                  onChange={(value) => setFormDispatchDay(Number(value))}
                />
              </div>
            ) : null}

            <div className={styles.field}>
              <span className={styles.label} id="subscription-time-label">
                发送时间
              </span>
              <div
                className={styles.timeRow}
                role="group"
                aria-labelledby="subscription-time-label"
              >
                <WarmSelect
                  id="subscription-hour"
                  hideLabel
                  ariaLabel="发送小时"
                  value={String(formDispatchHour)}
                  options={hourOptions}
                  onChange={(value) => setFormDispatchHour(Number(value))}
                  className={styles.timeSelect}
                />
                <span className={styles.colon} aria-hidden>
                  :
                </span>
                <WarmSelect
                  id="subscription-minute"
                  hideLabel
                  ariaLabel="发送分钟"
                  value={String(formDispatchMinute)}
                  options={minuteOptions}
                  onChange={(value) => setFormDispatchMinute(Number(value))}
                  className={styles.timeSelect}
                />
              </div>
            </div>
          </div>
        </section>

        {/* ── 模型 ── */}
        <section className={styles.section} aria-labelledby="subscription-section-model">
          <div className={styles.sectionHead}>
            <h3 className={styles.sectionTitle} id="subscription-section-model">
              模型
            </h3>
          </div>
          <div className={styles.grid2}>
            <div className={styles.field}>
              <span className={styles.label} id="subscription-model-label">
                AI 模型
              </span>
              <WarmSelect
                id="subscription-model"
                hideLabel
                ariaLabel="AI 模型"
                value={formAiModel}
                options={modelOptions}
                onChange={setFormAiModel}
                placeholder={
                  isLoadingModelConfig
                    ? '加载模型中...'
                    : modelOptions.length > 0
                      ? '选择模型'
                      : '暂无可用模型'
                }
                disabled={isLoadingModelConfig || modelOptions.length === 0}
              />
            </div>
          </div>
        </section>
      </div>

      <div className={styles.footerArea}>
        {formError ? (
          <div role="alert" aria-atomic="true" className={styles.formError}>
            <XCircle aria-hidden />
            <span>{formError}</span>
          </div>
        ) : null}
        <footer className={styles.footer} data-subscription-dialog-footer="true">
          {validationCount > 0 ? (
            <span className={styles.footerNote} role="status">
              <span aria-hidden>✗</span>
              {validationCount} 项待修正
            </span>
          ) : null}
          <span className={styles.footerPush} />
          <WarmButton onClick={onCancel} disabled={formSubmitting}>
            取消
          </WarmButton>
          <WarmButton
            variant="primary"
            onClick={onSubmit}
            disabled={formSubmitting || validationCount > 0}
            loading={formSubmitting}
          >
            {mode === 'create' ? '确认创建' : '保存修改'}
          </WarmButton>
        </footer>
      </div>
    </div>
  )
}
