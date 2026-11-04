'use client'

import { useForm, type Resolver } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { CrmUserSelect } from '@/components/crm/crm-user-select'
import { WarmButton, WarmSelect } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  CUSTOMER_RATING_LABELS,
  CUSTOMER_SOURCE_LABELS,
  CUSTOMER_STATUS_LABELS,
} from '@/lib/crm/enums/customer.enum'
import type { User } from '@/lib/crm/types/user'
import type { CustomerInput } from '@/lib/crm/types/customer'
import { customerSchema, type CustomerFormValues } from './schemas/customer.schema'

import styles from './crm-form-create-warm.module.css'

export interface CrmFormCreateProps {
  users: User[]
  /** 编辑时传入初始值（仅表单字段子集） */
  initialValues?: Partial<CustomerFormValues>
  onSubmit: (input: CustomerInput) => void | Promise<void>
  submitText?: string
}

/** 客户新建/编辑表单（react-hook-form + zod）。 */
export function CrmFormCreate({
  users,
  initialValues,
  onSubmit,
  submitText = '保存',
}: CrmFormCreateProps) {
  const form = useForm<CustomerFormValues>({
    resolver: zodResolver(customerSchema) as Resolver<CustomerFormValues>,
    defaultValues: {
      name: '',
      shortName: '',
      industry: '',
      rating: 'B',
      status: 'active',
      source: 'referral',
      ownerId: null,
      contactName: '',
      contactPhone: '',
      contactEmail: '',
      address: '',
      website: '',
      annualRevenue: undefined,
      employeeCount: undefined,
      remark: '',
      ...initialValues,
    },
  })

  async function handleSubmit(values: CustomerFormValues) {
    const input: CustomerInput = {
      name: values.name,
      shortName: values.shortName || undefined,
      industry: values.industry || undefined,
      rating: values.rating as CustomerInput['rating'],
      status: values.status as CustomerInput['status'],
      source: values.source as CustomerInput['source'],
      ownerId: values.ownerId ?? null,
      contactName: values.contactName || undefined,
      contactPhone: values.contactPhone || undefined,
      contactEmail: values.contactEmail || undefined,
      address: values.address || undefined,
      website: values.website || undefined,
      annualRevenue: values.annualRevenue,
      employeeCount: values.employeeCount,
      remark: values.remark || undefined,
    }
    await onSubmit(input)
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className={styles.form}>
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel className={styles.label}>客户名 *</FormLabel>
              <FormControl>
                <Input {...field} className={styles.input} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className={styles.grid}>
          <FormField
            control={form.control}
            name="rating"
            render={({ field }) => (
              <FormItem>
                <WarmSelect
                  id="customer-rating"
                  label="等级"
                  value={field.value}
                  options={Object.entries(CUSTOMER_RATING_LABELS).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                  onChange={field.onChange}
                />
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem>
                <WarmSelect
                  id="customer-status"
                  label="状态"
                  value={field.value}
                  options={Object.entries(CUSTOMER_STATUS_LABELS).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                  onChange={field.onChange}
                />
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
              <WarmSelect
                id="customer-source"
                label="来源"
                value={field.value}
                options={Object.entries(CUSTOMER_SOURCE_LABELS).map(([value, label]) => ({
                  value,
                  label,
                }))}
                onChange={field.onChange}
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="ownerId"
          render={({ field }) => (
            <FormItem>
              <FormLabel className={styles.label}>负责人</FormLabel>
              <FormControl>
                <CrmUserSelect
                  users={users}
                  value={field.value}
                  onChange={field.onChange}
                  className={styles.trigger}
                  visual="warm"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className={styles.grid}>
          <FormField
            control={form.control}
            name="contactName"
            render={({ field }) => (
              <FormItem>
                <FormLabel className={styles.label}>联系人</FormLabel>
                <FormControl>
                  <Input {...field} value={field.value ?? ''} className={styles.input} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="contactPhone"
            render={({ field }) => (
              <FormItem>
                <FormLabel className={styles.label}>联系电话</FormLabel>
                <FormControl>
                  <Input {...field} value={field.value ?? ''} className={styles.input} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="contactEmail"
          render={({ field }) => (
            <FormItem>
              <FormLabel className={styles.label}>联系邮箱</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} className={styles.input} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="industry"
          render={({ field }) => (
            <FormItem>
              <FormLabel className={styles.label}>行业</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} className={styles.input} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="address"
          render={({ field }) => (
            <FormItem>
              <FormLabel className={styles.label}>地址</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} className={styles.input} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="remark"
          render={({ field }) => (
            <FormItem>
              <FormLabel className={styles.label}>备注</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  value={field.value ?? ''}
                  rows={3}
                  className={styles.textarea}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className={styles.actions}>
          <WarmButton
            type="submit"
            variant="primary"
            loading={form.formState.isSubmitting}
            loadingLabel="正在保存客户"
          >
            {form.formState.isSubmitting ? '保存中…' : submitText}
          </WarmButton>
        </div>
      </form>
    </Form>
  )
}
