'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useSession } from 'next-auth/react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AIModelConfig, Frequency } from './types'
import {
  SubscriptionForm,
  subscriptionCountryError,
  subscriptionEmailError,
  subscriptionProjectError,
} from './SubscriptionForm'
import { sendTestEmail, createSubscription } from './api'
import styles from './subscription-dialog-warm.module.css'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Array<{ id?: number | null; name: string }>
  modelConfig: AIModelConfig | null
  isLoadingModelConfig: boolean
  onSuccess: () => void
}

/**
 * 创建 / 编辑订阅共用的页面本地 Warm 弹窗外壳（方案 A）。
 *
 * Warm token 只定义在 `#warm-ledger-portal-root` / `.warm-ledger` 子树内，因此
 * Radix Dialog 必须显式 portal 到该根节点；默认 portal 到 body 会让弹窗表面
 * 失去 token（透明）并破坏主题跟随。
 */
export function SubscriptionDialogFrame({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
}) {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)

  useEffect(() => {
    setPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal container={portalContainer ?? undefined}>
        <DialogPrimitive.Overlay className={styles.overlay} />
        <DialogPrimitive.Content
          className={cn(styles.dialog, 'ui-modal-motion')}
          aria-describedby={undefined}
          data-warm-ledger-dialog="true"
        >
          <header className={styles.dialogHead}>
            <DialogPrimitive.Title className={styles.dialogTitle}>
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close className={styles.dialogClose} aria-label="关闭">
              <X aria-hidden />
            </DialogPrimitive.Close>
          </header>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
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
    const result = await createSubscription({
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
      setFormError(result.error || '创建失败')
    }
    setFormSubmitting(false)
  }

  return (
    <SubscriptionDialogFrame open={open} onOpenChange={onOpenChange} title="新增订阅">
      <SubscriptionForm
        mode="create"
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
