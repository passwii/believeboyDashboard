'use client'

import { useId } from 'react'
import {
  Controller,
  useForm,
  type Resolver,
} from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import {
  WarmButton,
  WarmSelect,
} from '@/components/dashboard-v2/warm-ledger/controls'
import {
  TASK_PRIORITY_LABELS,
  TASK_TYPE_LABELS,
} from '@/lib/crm/enums/task.enum'
import type { User } from '@/lib/crm/types/user'
import type { TaskInput } from '@/lib/crm/types/task'
import { taskSchema, type TaskFormValues } from './schemas/task.schema'
import styles from './task-form.module.css'

export interface CrmTaskFormProps {
  users: User[]
  /** 编辑时传入初始值（仅表单字段子集）；新建缺省默认值 */
  initialValues?: Partial<TaskFormValues>
  /** 新建弹窗固定关联实体（客户/线索抽屉内）——表单隐藏关联选择 */
  onSubmit: (input: TaskInput) => void | Promise<void>
  submitText?: string
}

const TYPE_OPTIONS = Object.entries(TASK_TYPE_LABELS).map(([value, label]) => ({
  value,
  label,
}))

const PRIORITY_OPTIONS = Object.entries(TASK_PRIORITY_LABELS).map(([value, label]) => ({
  value,
  label,
}))

function normalizeDateInput(value?: string) {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 任务新建/编辑表单（react-hook-form + zod）。
 * 标题必填；类型/优先级/截止/描述/负责人可选（负责人权限仍由后端校验）。
 */
export function CrmTaskForm({
  users,
  initialValues,
  onSubmit,
  submitText = '保存',
}: CrmTaskFormProps) {
  const formId = useId()
  const titleId = `${formId}-title`
  const titleErrorId = `${formId}-title-error`
  const dueDateId = `${formId}-due-date`
  const dueDateErrorId = `${formId}-due-date-error`
  const descriptionId = `${formId}-description`
  const descriptionErrorId = `${formId}-description-error`

  const baseValues: TaskFormValues = {
    title: '',
    type: 'custom',
    priority: 'medium',
    dueDate: '',
    description: '',
    ownerId: null,
  }
  const defaultValues: TaskFormValues = {
    ...baseValues,
    ...initialValues,
    dueDate: normalizeDateInput(initialValues?.dueDate ?? ''),
  }

  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskSchema) as Resolver<TaskFormValues>,
    defaultValues,
  })
  const errors = form.formState.errors

  async function handleSubmit(values: TaskFormValues) {
    const input: TaskInput = {
      title: values.title,
      type: values.type,
      priority: values.priority,
      dueDate: values.dueDate || undefined,
      description: values.description || undefined,
      ownerId: values.ownerId || null,
    }
    await onSubmit(input)
  }

  const ownerOptions = users.map((user) => ({
    value: user.id,
    label: user.name,
  }))

  return (
    <form
      onSubmit={form.handleSubmit(handleSubmit)}
      className={styles.form}
      data-warm-task-form
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor={titleId}>
          标题 *
        </label>
        <input
          {...form.register('title')}
          id={titleId}
          className={styles.input}
          placeholder="如：确认报价单并发送客户"
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? titleErrorId : undefined}
        />
        <FieldError id={titleErrorId} message={errors.title?.message} />
      </div>

      <div className={styles.pair}>
        <Controller
          control={form.control}
          name="type"
          render={({ field, fieldState }) => (
            <WarmSelect
              id={`${formId}-type`}
              label="类型"
              value={field.value}
              options={TYPE_OPTIONS}
              onChange={field.onChange}
              error={fieldState.error?.message ?? null}
            />
          )}
        />
        <Controller
          control={form.control}
          name="priority"
          render={({ field, fieldState }) => (
            <WarmSelect
              id={`${formId}-priority`}
              label="优先级"
              value={field.value}
              options={PRIORITY_OPTIONS}
              onChange={field.onChange}
              error={fieldState.error?.message ?? null}
            />
          )}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={dueDateId}>
          截止时间
        </label>
        <input
          {...form.register('dueDate')}
          id={dueDateId}
          type="date"
          className={styles.input}
          aria-invalid={errors.dueDate ? true : undefined}
          aria-describedby={errors.dueDate ? dueDateErrorId : undefined}
        />
        <FieldError id={dueDateErrorId} message={errors.dueDate?.message} />
      </div>

      <Controller
        control={form.control}
        name="ownerId"
        render={({ field, fieldState }) => (
          <WarmSelect
            id={`${formId}-owner`}
            label="负责人"
            value={field.value ?? ''}
            options={ownerOptions}
            onChange={field.onChange}
            placeholder="选择负责人（留空=自己）"
            error={fieldState.error?.message ?? null}
          />
        )}
      />

      <div className={styles.field}>
        <label className={styles.label} htmlFor={descriptionId}>
          描述
        </label>
        <textarea
          {...form.register('description')}
          id={descriptionId}
          value={form.watch('description') ?? ''}
          rows={3}
          className={styles.textarea}
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={errors.description ? descriptionErrorId : undefined}
        />
        <FieldError id={descriptionErrorId} message={errors.description?.message} />
      </div>

      <div className={styles.submitRow}>
        <WarmButton
          type="submit"
          variant="primary"
          loading={form.formState.isSubmitting}
          loadingLabel="保存中…"
        >
          {form.formState.isSubmitting ? '保存中…' : submitText}
        </WarmButton>
      </div>
    </form>
  )
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <p id={id} role="alert" className={styles.error}>
      {message}
    </p>
  )
}
