'use client'

import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
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
  LEAD_INTENT_LABELS,
  LEAD_STATUS_LABELS,
} from '@/lib/crm/enums/lead.enum'
import { CUSTOMER_SOURCE_LABELS } from '@/lib/crm/enums/customer.enum'
import type { User } from '@/lib/crm/types/user'
import type { LeadInput } from '@/lib/crm/types/lead'
import { leadSchema, type LeadFormValues } from './schemas/lead.schema'

export interface CrmLeadFormProps {
  users: User[]
  /** 编辑时传入初始值（仅表单字段子集） */
  initialValues?: Partial<LeadFormValues>
  onSubmit: (input: LeadInput) => void | Promise<void>
  submitText?: string
}

/** 线索新建/编辑表单（react-hook-form + zod）。 */
export function CrmLeadForm({
  users,
  initialValues,
  onSubmit,
  submitText = '保存',
}: CrmLeadFormProps) {
  const form = useForm<LeadFormValues>({
    resolver: zodResolver(leadSchema) as Resolver<LeadFormValues>,
    defaultValues: {
      name: '',
      company: '',
      phone: '',
      email: '',
      wechat: '',
      source: 'referral',
      status: 'new',
      intent: 'medium',
      ownerId: null,
      expectedAmount: undefined,
      expectedCloseDate: '',
      remark: '',
      ...initialValues,
    },
  })

  async function handleSubmit(values: LeadFormValues) {
    const input: LeadInput = {
      name: values.name,
      company: values.company || undefined,
      phone: values.phone || undefined,
      email: values.email || undefined,
      wechat: values.wechat || undefined,
      source: values.source,
      status: values.status,
      intent: values.intent,
      ownerId: values.ownerId ?? null,
      expectedAmount: values.expectedAmount,
      expectedCloseDate: values.expectedCloseDate || undefined,
      remark: values.remark || undefined,
    }
    await onSubmit(input)
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>联系人 *</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <FormField
            control={form.control}
            name="company"
            render={({ field }) => (
              <FormItem>
                <FormLabel>公司</FormLabel>
                <FormControl>
                  <Input {...field} value={field.value ?? ''} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>电话</FormLabel>
                <FormControl>
                  <Input {...field} value={field.value ?? ''} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>邮箱</FormLabel>
                <FormControl>
                  <Input {...field} value={field.value ?? ''} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="wechat"
            render={({ field }) => (
              <FormItem>
                <FormLabel>微信</FormLabel>
                <FormControl>
                  <Input {...field} value={field.value ?? ''} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="source"
          render={({ field }) => (
            <FormItem>
              <FormLabel>来源</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {Object.entries(CUSTOMER_SOURCE_LABELS).map(([v, l]) => (
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

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>状态</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {Object.entries(LEAD_STATUS_LABELS).map(([v, l]) => (
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
            name="intent"
            render={({ field }) => (
              <FormItem>
                <FormLabel>意向</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {Object.entries(LEAD_INTENT_LABELS).map(([v, l]) => (
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
          name="ownerId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>负责人</FormLabel>
              <FormControl>
                <CrmUserSelect users={users} value={field.value} onChange={field.onChange} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <FormField
            control={form.control}
            name="expectedAmount"
            render={({ field }) => (
              <FormItem>
                <FormLabel>预计金额</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    {...field}
                    value={field.value ?? ''}
                    onChange={(e) => field.onChange(e.target.valueAsNumber || undefined)}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="expectedCloseDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>预计成交日</FormLabel>
                <FormControl>
                  <Input type="date" {...field} value={field.value ?? ''} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="remark"
          render={({ field }) => (
            <FormItem>
              <FormLabel>备注</FormLabel>
              <FormControl>
                <Textarea {...field} value={field.value ?? ''} rows={3} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" className="w-full">
          {submitText}
        </Button>
      </form>
    </Form>
  )
}
