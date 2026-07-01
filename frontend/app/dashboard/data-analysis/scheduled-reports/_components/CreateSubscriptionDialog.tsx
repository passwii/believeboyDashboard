'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { normalizeErrorMessage } from '@/lib/error-utils'
import type { AIModelConfig, Frequency } from './types'
import { SubscriptionForm } from './SubscriptionForm'
import { sendTestEmail, createSubscription } from './api'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Array<{ id?: number | null; name: string }>
  modelConfig: AIModelConfig | null
  isLoadingModelConfig: boolean
  onSuccess: () => void
}

export function CreateSubscriptionDialog({
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

  useSession()

  useEffect(() => {
    if (open && modelConfig?.defaultModel) {
      setFormAiModel(modelConfig.defaultModel)
    }
  }, [open, modelConfig?.defaultModel])

  const handleTestEmail = async () => {
    if (!formEmail.trim()) {
      setTestResult({ success: false, message: '请先填写测试邮箱地址' })
      return
    }
    setTestingEmail(true)
    setTestResult(null)
    const result = await sendTestEmail({
      email: formEmail,
      frequency: formFrequency,
      project_ids: formProjectIds || '*',
      country: formCountries.join(','),
      ai_model: formAiModel || null,
    })
    setTestResult(result)
    setTestingEmail(false)
  }

  const handleSubmit = async () => {
    if (!formEmail.trim()) {
      setFormError('请填写邮箱地址')
      return
    }
    setFormSubmitting(true)
    setFormError(null)
    const result = await createSubscription({
      email: formEmail,
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
      setFormError(result.error || '创建失败')
    }
    setFormSubmitting(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-[540px] md:max-w-2xl dark:border-border/80 dark:bg-[hsl(var(--surface-panel))]">
        <SubscriptionForm
          mode="create"
          formEmail={formEmail} setFormEmail={setFormEmail}
          formProjectIds={formProjectIds} setFormProjectIds={setFormProjectIds}
          formSelectedProjectIds={formSelectedProjectIds} setFormSelectedProjectIds={setFormSelectedProjectIds}
          formCountries={formCountries} setFormCountries={setFormCountries}
          formFrequency={formFrequency} setFormFrequency={setFormFrequency}
          formDispatchHour={formDispatchHour} setFormDispatchHour={setFormDispatchHour}
          formDispatchMinute={formDispatchMinute} setFormDispatchMinute={setFormDispatchMinute}
          formDispatchWeekday={formDispatchWeekday} setFormDispatchWeekday={setFormDispatchWeekday}
          formDispatchDay={formDispatchDay} setFormDispatchDay={setFormDispatchDay}
          formAiModel={formAiModel} setFormAiModel={setFormAiModel}
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
      </DialogContent>
    </Dialog>
  )
}
