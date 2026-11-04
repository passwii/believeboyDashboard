'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useForm, type Resolver } from 'react-hook-form'

import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import { CUSTOMER_SOURCE_LABELS } from '@/lib/crm/enums/customer.enum'
import { LEAD_INTENT_LABELS, LEAD_STATUS_LABELS } from '@/lib/crm/enums/lead.enum'
import type { LeadInput } from '@/lib/crm/types/lead'
import type { User } from '@/lib/crm/types/user'

import styles from '@/app/dashboard/crm/leads/leads-warm.module.css'
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
      <form
        className={styles.form}
        data-warm-lead-form
        onSubmit={form.handleSubmit(handleSubmit)}
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem className={styles.field}>
              <FormLabel className={styles.label}>联系人 *</FormLabel>
              <FormControl>
                <input className={styles.input} {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage className={styles.message} />
            </FormItem>
          )}
        />

        <div className={styles.formGrid}>
          <FormField
            control={form.control}
            name="company"
            render={({ field }) => (
              <FormItem className={styles.field}>
                <FormLabel className={styles.label}>公司</FormLabel>
                <FormControl>
                  <input className={styles.input} {...field} value={field.value ?? ''} />
                </FormControl>
                <FormMessage className={styles.message} />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem className={styles.field}>
                <FormLabel className={styles.label}>电话</FormLabel>
                <FormControl>
                  <input className={styles.input} {...field} value={field.value ?? ''} />
                </FormControl>
                <FormMessage className={styles.message} />
              </FormItem>
            )}
          />
        </div>

        <div className={styles.formGrid}>
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem className={styles.field}>
                <FormLabel className={styles.label}>邮箱</FormLabel>
                <FormControl>
                  <input className={styles.input} {...field} value={field.value ?? ''} />
                </FormControl>
                <FormMessage className={styles.message} />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="wechat"
            render={({ field }) => (
              <FormItem className={styles.field}>
                <FormLabel className={styles.label}>微信</FormLabel>
                <FormControl>
                  <input className={styles.input} {...field} value={field.value ?? ''} />
                </FormControl>
                <FormMessage className={styles.message} />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="source"
          render={({ field }) => (
            <FormItem className={styles.field}>
              <FormLabel className={styles.label}>来源</FormLabel>
              <FormControl>
                <select
                  className={styles.select}
                  onChange={field.onChange}
                  value={field.value}
                >
                  {Object.entries(CUSTOMER_SOURCE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormMessage className={styles.message} />
            </FormItem>
          )}
        />

        <div className={styles.formGrid}>
          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem className={styles.field}>
                <FormLabel className={styles.label}>状态</FormLabel>
                <FormControl>
                  <select
                    className={styles.select}
                    onChange={field.onChange}
                    value={field.value}
                  >
                    {Object.entries(LEAD_STATUS_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </FormControl>
                <FormMessage className={styles.message} />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="intent"
            render={({ field }) => (
              <FormItem className={styles.field}>
                <FormLabel className={styles.label}>意向</FormLabel>
                <FormControl>
                  <select
                    className={styles.select}
                    onChange={field.onChange}
                    value={field.value}
                  >
                    {Object.entries(LEAD_INTENT_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </FormControl>
                <FormMessage className={styles.message} />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="ownerId"
          render={({ field }) => (
            <FormItem className={styles.field}>
              <FormLabel className={styles.label}>负责人</FormLabel>
              <FormControl>
                <select
                  className={styles.select}
                  onChange={(event) => field.onChange(event.target.value || null)}
                  value={field.value ?? ''}
                >
                  <option value="">选择负责人</option>
                  {users.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormMessage className={styles.message} />
            </FormItem>
          )}
        />

        <div className={styles.formGrid}>
          <FormField
            control={form.control}
            name="expectedAmount"
            render={({ field }) => (
              <FormItem className={styles.field}>
                <FormLabel className={styles.label}>预计金额</FormLabel>
                <FormControl>
                  <input
                    className={styles.input}
                    type="number"
                    {...field}
                    value={field.value ?? ''}
                    onChange={(event) =>
                      field.onChange(event.target.valueAsNumber || undefined)
                    }
                  />
                </FormControl>
                <FormMessage className={styles.message} />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="expectedCloseDate"
            render={({ field }) => (
              <FormItem className={styles.field}>
                <FormLabel className={styles.label}>预计成交日</FormLabel>
                <FormControl>
                  <input
                    className={styles.input}
                    type="date"
                    {...field}
                    value={field.value ?? ''}
                  />
                </FormControl>
                <FormMessage className={styles.message} />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="remark"
          render={({ field }) => (
            <FormItem className={styles.field}>
              <FormLabel className={styles.label}>备注</FormLabel>
              <FormControl>
                <textarea
                  className={styles.textarea}
                  {...field}
                  rows={3}
                  value={field.value ?? ''}
                />
              </FormControl>
              <FormMessage className={styles.message} />
            </FormItem>
          )}
        />

        <WarmButton className={styles.submitButton} type="submit" variant="primary">
          {submitText}
        </WarmButton>
      </form>
    </Form>
  )
}
