'use client'

import { useEffect, useMemo, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ArrowRight, Bot, X } from 'lucide-react'
import {
  WarmButton,
  WarmIconButton,
} from '@/components/dashboard-v2/warm-ledger/controls'
import {
  DEFAULT_FORM_VALUES,
  ENTITY_LABELS,
  parseRuleToForm,
  toRuleInput,
  type RuleFormValues,
} from './rule-editor-utils'
import type { Rule, RuleInput } from '@/lib/crm/types'

import styles from './rule-editor.module.css'

const ruleSchema = z.object({
  name: z.string().trim().min(1, '请输入规则名称').max(200, '规则名称最多 200 字'),
  description: z.string().max(500, '描述最多 500 字'),
  entityType: z.enum(['customer', 'lead']),
  days: z.coerce
    .number({ error: '请输入天数' })
    .int('天数需为整数')
    .min(1, '天数至少为 1')
    .max(365, '天数最多 365'),
  onlyNeverFollowed: z.boolean(),
  enabled: z.boolean(),
})

export interface CrmRuleEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 编辑时传入规则；新建缺省 */
  rule?: Rule
  onSubmit: (input: RuleInput) => void | Promise<void>
}

/**
 * 「当 X 发生，做 Y」规则编辑器（P9-7，BLF-545）。
 *
 * 表单语义与 MVP 结构保持原样，仅将 Dialog/表单表面迁移到 Warm Ledger。
 */
export function CrmRuleEditor({ open, onOpenChange, rule, onSubmit }: CrmRuleEditorProps) {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)
  const initial = useMemo(() => {
    if (!rule) return { values: DEFAULT_FORM_VALUES, unsupported: false }
    return parseRuleToForm(rule)
  }, [rule])

  const form = useForm<RuleFormValues>({
    resolver: zodResolver(ruleSchema) as Resolver<RuleFormValues>,
    defaultValues: initial.values,
  })

  useEffect(() => {
    setPortalContainer(document.getElementById('warm-ledger-portal-root'))
  }, [])

  useEffect(() => {
    if (open) form.reset(initial.values)
  }, [open, initial, form])

  const watched = form.watch()
  const preview = useMemo(() => {
    const entity = ENTITY_LABELS[watched.entityType]
    const parts = [`${entity}创建超过 ${watched.days || '—'} 天`]
    if (watched.onlyNeverFollowed) parts.push('从未跟进')
    return `当${parts.join(' 且 ')} → 提醒负责人`
  }, [watched.entityType, watched.days, watched.onlyNeverFollowed])

  const errors = form.formState.errors

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal container={portalContainer}>
        <DialogPrimitive.Overlay className={styles.overlay} />
        <DialogPrimitive.Content
          className={styles.dialog}
          data-warm-rule-editor
        >
          <header className={styles.header}>
            <div>
              <DialogPrimitive.Title className={styles.title}>
                {rule ? '编辑规则' : '新建规则'}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className={styles.description}>
                可视化配置「当 X 发生，做 Y」。MVP 支持：实体创建超过 N 天无跟进 → 提醒负责人。
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <WarmIconButton aria-label="关闭">
                <X aria-hidden="true" />
              </WarmIconButton>
            </DialogPrimitive.Close>
          </header>

          {initial.unsupported ? (
            <div className={styles.warning}>
              该规则包含暂不支持编辑的条件/动作组合（MVP 仅支持「创建超过 N 天 且 从未跟进 →
              提醒负责人」）。如需调整，请删除后按 MVP 结构重建。
            </div>
          ) : (
            <form
              className={styles.form}
              onSubmit={form.handleSubmit(async (values) => {
                await onSubmit(toRuleInput(values))
              })}
            >
              <label className={styles.field}>
                <span>规则名称 *</span>
                <input
                  {...form.register('name')}
                  aria-invalid={errors.name ? true : undefined}
                  placeholder="如：客户 7 天无跟进提醒"
                />
                {errors.name ? (
                  <span className={styles.error}>{errors.name.message}</span>
                ) : null}
              </label>

              <fieldset className={styles.fieldGroup}>
                <legend>当</legend>
                <div className={styles.conditionRow}>
                  <label className={styles.inlineField}>
                    <span>对象</span>
                    <select {...form.register('entityType')}>
                      {Object.entries(ENTITY_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span className={styles.connector}>创建超过</span>
                  <label className={styles.inlineField}>
                    <span className={styles.srOnly}>创建超过天数</span>
                    <input
                      {...form.register('days', { valueAsNumber: true })}
                      type="number"
                      min={1}
                      max={365}
                      aria-label="创建超过天数"
                      className={styles.daysInput}
                    />
                  </label>
                  <span className={styles.connector}>天</span>
                  <label className={styles.checkboxField}>
                    <input {...form.register('onlyNeverFollowed')} type="checkbox" />
                    <span>且从未跟进</span>
                  </label>
                </div>
                {errors.days ? (
                  <span className={styles.error}>{errors.days.message}</span>
                ) : null}
              </fieldset>

              <fieldset className={styles.fieldGroup}>
                <legend>做</legend>
                <div className={styles.actionRow}>
                  <Bot aria-hidden="true" />
                  <span>提醒负责人</span>
                  <span className={styles.actionHint}>（站内提醒，每日 09:05 自动扫描）</span>
                </div>
              </fieldset>

              <div className={styles.enabledRow}>
                <div>
                  <span className={styles.enabledLabel}>启用规则</span>
                  <span className={styles.enabledHint}>关闭后规则暂停执行，不删除配置</span>
                </div>
                <SwitchPrimitive.Root
                  checked={watched.enabled}
                  onCheckedChange={(checked) =>
                    form.setValue('enabled', checked, { shouldDirty: true })
                  }
                  aria-label="启用规则"
                  className={styles.switch}
                >
                  <SwitchPrimitive.Thumb className={styles.switchThumb} />
                </SwitchPrimitive.Root>
              </div>

              <div className={styles.preview}>
                <ArrowRight aria-hidden="true" />
                <p>
                  <span>{watched.name || '规则预览'}</span>
                  <br />
                  {preview}
                </p>
              </div>

              <footer className={styles.footer}>
                <WarmButton
                  variant="quiet"
                  onClick={() => onOpenChange(false)}
                  className={styles.cancelButton}
                >
                  取消
                </WarmButton>
                <WarmButton
                  type="submit"
                  variant="primary"
                  disabled={form.formState.isSubmitting}
                  loading={form.formState.isSubmitting}
                >
                  {form.formState.isSubmitting ? '保存中…' : '保存'}
                </WarmButton>
              </footer>
            </form>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
