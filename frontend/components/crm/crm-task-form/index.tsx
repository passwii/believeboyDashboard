'use client'

import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { DatePicker } from '@/components/ui/date-picker'
import { parseDateInputValue, formatDateInputValue } from '@/components/ui/date-picker'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { CrmUserSelect } from '@/components/crm/crm-user-select'
import {
  TASK_PRIORITY_LABELS,
  TASK_TYPE_LABELS,
} from '@/lib/crm/enums/task.enum'
import type { User } from '@/lib/crm/types/user'
import type { TaskInput } from '@/lib/crm/types/task'
import { taskSchema, type TaskFormValues } from './schemas/task.schema'

export interface CrmTaskFormProps {
  users: User[]
  /** 编辑时传入初始值（仅表单字段子集）；新建缺省默认值 */
  initialValues?: Partial<TaskFormValues>
  /** 新建弹窗固定关联实体（客户/线索抽屉内）——表单隐藏关联选择 */
  onSubmit: (input: TaskInput) => void | Promise<void>
  submitText?: string
}

/**
 * 任务新建/编辑表单（react-hook-form + zod）。
 * 标题必填；类型/优先级/截止/描述/负责人可选（负责人仅 admin 可指派他人）。
 * 新建与编辑复用同一组件（编辑传 initialValues）。
 */
export function CrmTaskForm({
  users,
  initialValues,
  onSubmit,
  submitText = '保存',
}: CrmTaskFormProps) {
  const form = useForm<TaskFormValues>({
    resolver: zodResolver(taskSchema) as Resolver<TaskFormValues>,
    defaultValues: {
      title: '',
      type: 'custom',
      priority: 'medium',
      dueDate: '',
      description: '',
      ownerId: null,
      ...initialValues,
    },
  })

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

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>标题 *</FormLabel>
              <FormControl>
                <Input {...field} placeholder="如：确认报价单并发送客户" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <FormField
            control={form.control}
            name="type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>类型</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {Object.entries(TASK_TYPE_LABELS).map(([v, l]) => (
                      <SelectItem key={v} value={v}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="priority"
            render={({ field }) => (
              <FormItem>
                <FormLabel>优先级</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {Object.entries(TASK_PRIORITY_LABELS).map(([v, l]) => (
                      <SelectItem key={v} value={v}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="dueDate"
          render={({ field }) => (
            <FormItem className="flex flex-col">
              <FormLabel>截止时间</FormLabel>
              <FormControl>
                <DatePicker
                  mode="single"
                  value={parseDateInputValue(field.value)}
                  onChange={(d) => field.onChange(d ? formatDateInputValue(d) : '')}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="ownerId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>负责人</FormLabel>
              <FormControl>
                <CrmUserSelect
                  users={users}
                  value={field.value}
                  onChange={(v) => field.onChange(v)}
                  placeholder="选择负责人（留空=自己）"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>描述</FormLabel>
              <FormControl>
                <Textarea {...field} value={field.value ?? ''} rows={3} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? '保存中…' : submitText}
          </Button>
        </div>
      </form>
    </Form>
  )
}
