'use client'

import { useEffect, useState } from 'react'
import type { AIModelConfig, Frequency, Subscription } from './types'
import {
  SubscriptionForm,
  subscriptionCountryError,
  subscriptionEmailError,
  subscriptionProjectError,
} from './SubscriptionForm'
import { SubscriptionDialogFrame } from './CreateSubscriptionDialog'
import { sendTestEmail, updateSubscription } from './api'

interface Props {
  subscription: Subscription | null
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Array<{ id?: number | null; name: string }>
  modelConfig: AIModelConfig | null
  isLoadingModelConfig: boolean
  onSuccess: () => void
}

export function EditSubscriptionDialog({
  subscription,
  open,
  onOpenChange,
  projects,
  modelConfig,
  isLoadingModelConfig,
  onSuccess,
}: Props) {
  const [formEmail, setFormEmail] = useState('')
  const [formProjectIds, setFormProjectIds] = useState('*')
  const [formSelectedProjectIds, setFormSelectedProjectIds] = useState<string[]>([])
  const [formCountries, setFormCountries] = useState<string[]>(['US'])
  const [formFrequency, setFormFrequency] = useState<Frequency>('daily')
  const [formDispatchHour, setFormDispatchHour] = useState(15)
  const [formDispatchMinute, setFormDispatchMinute] = useState(0)
  const [formDispatchWeekday, setFormDispatchWeekday] = useState(0)
  const [formDispatchDay, setFormDispatchDay] = useState(2)
  const [formAiModel, setFormAiModel] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null)
  const [formSubmitting, setFormSubmitting] = useState(false)
  const [testingEmail, setTestingEmail] = useState(false)

  useEffect(() => {
    if (open && subscription) {
      setFormEmail(subscription.email || '')
      setFormProjectIds(subscription.project_ids || '*')
      if (subscription.project_ids === '*' || !subscription.project_ids) {
        setFormSelectedProjectIds([])
      } else {
        setFormSelectedProjectIds(
          subscription.project_ids
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        )
      }
      const countries = subscription.country
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean)
      // 历史数据/异常响应可能没有国家：编辑时回退到后端默认的 US，避免静默提交空值。
      setFormCountries(countries.length > 0 ? countries : ['US'])
      setFormFrequency(subscription.frequency)
      setFormDispatchHour(subscription.dispatch_hour)
      setFormDispatchMinute(subscription.dispatch_minute ?? 0)
      setFormDispatchWeekday(subscription.dispatch_weekday ?? 0)
      setFormDispatchDay(subscription.dispatch_day ?? 2)
      setFormAiModel(subscription.ai_model || modelConfig?.defaultModel || '')
      setFormError(null)
      setTestResult(null)
    }
  }, [open, subscription, modelConfig?.defaultModel])

  const handleTestEmail = async () => {
    const email = formEmail.trim()
    if (!email) {
      setTestResult({ success: false, message: '请先填写测试邮箱地址' })
      return
    }
    setTestingEmail(true)
    setTestResult(null)
    const result = await sendTestEmail({
      email,
      frequency: formFrequency,
      project_ids: formProjectIds || '*',
      country: formCountries.join(','),
      ai_model: formAiModel || null,
    })
    setTestResult(result)
    setTestingEmail(false)
  }

  const handleSubmit = async () => {
    if (!subscription) return
    const email = formEmail.trim()
    const validationError =
      subscriptionEmailError(email) ||
      subscriptionCountryError(formCountries) ||
      subscriptionProjectError(formProjectIds, formSelectedProjectIds)
    if (validationError) {
      setFormError(validationError)
      return
    }
    setFormSubmitting(true)
    setFormError(null)
    const result = await updateSubscription(subscription.id, {
      email: email || null,
      project_ids: formProjectIds || '*',
      country: formCountries.join(','),
      frequency: formFrequency,
      dispatch_hour: formDispatchHour,
      dispatch_minute: formDispatchMinute,
      dispatch_weekday: formFrequency === 'weekly' ? formDispatchWeekday : null,
      dispatch_day: formFrequency === 'monthly' ? formDispatchDay : null,
      ai_model: formAiModel || null,
    })
    if (result.ok) {
      onOpenChange(false)
      onSuccess()
    } else {
      setFormError(result.error || '更新失败')
    }
    setFormSubmitting(false)
  }

  if (!subscription) return null

  return (
    <SubscriptionDialogFrame open={open} onOpenChange={onOpenChange} title="编辑订阅">
      <SubscriptionForm
        mode="edit"
        formEmail={formEmail}
        setFormEmail={setFormEmail}
        formProjectIds={formProjectIds}
        setFormProjectIds={setFormProjectIds}
        formSelectedProjectIds={formSelectedProjectIds}
        setFormSelectedProjectIds={setFormSelectedProjectIds}
        formCountries={formCountries}
        setFormCountries={setFormCountries}
        formFrequency={formFrequency}
        setFormFrequency={setFormFrequency}
        formDispatchHour={formDispatchHour}
        setFormDispatchHour={setFormDispatchHour}
        formDispatchMinute={formDispatchMinute}
        setFormDispatchMinute={setFormDispatchMinute}
        formDispatchWeekday={formDispatchWeekday}
        setFormDispatchWeekday={setFormDispatchWeekday}
        formDispatchDay={formDispatchDay}
        setFormDispatchDay={setFormDispatchDay}
        formAiModel={formAiModel}
        setFormAiModel={setFormAiModel}
        projects={projects}
        modelConfig={modelConfig}
        isLoadingModelConfig={isLoadingModelConfig}
        formError={formError}
        testResult={testResult}
        formSubmitting={formSubmitting}
        testingEmail={testingEmail}
        onTestEmail={handleTestEmail}
        onSubmit={handleSubmit}
        onCancel={() => onOpenChange(false)}
      />
    </SubscriptionDialogFrame>
  )
}
