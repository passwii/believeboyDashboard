'use client'

import { useEffect, useState } from 'react'
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
import { CrmCustomerSelect } from '@/components/crm/crm-customer-select'
import { OPPORTUNITY_STAGE_LABELS } from '@/lib/crm/enums/opportunity.enum'
import { useCrmClient } from '@/lib/crm/api/crm-client-provider'
import type { User } from '@/lib/crm/types/user'
import type { Customer } from '@/lib/crm/types'
import type { OpportunityInput } from '@/lib/crm/types/opportunity'
import { opportunitySchema, type OpportunityFormValues } from './schemas/opportunity.schema'

export interface CrmOpportunityFormProps {
  users: User[]
  /** 编辑时传入初始值（仅表单字段子集） */
  initialValues?: Partial<OpportunityFormValues>
  onSubmit: (input: OpportunityInput) => void | Promise<void>
  submitText?: string
}

/** 商机新建/编辑表单（react-hook-form + zod）。 */
export function CrmOpportunityForm({
  users,
  initialValues,
  onSubmit,
  submitText = '保存',
}: CrmOpportunityFormProps) {
  const client = useCrmClient()
  const [customers, setCustomers] = useState<Customer[]>([])

  useEffect(() => {
    let alive = true
    void client
      .listCustomers({ pageSize: 200 })
      .then((page) => {
        if (alive) setCustomers(page.items)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [client])

  const form = useForm<OpportunityFormValues>({
    resolver: zodResolver(opportunitySchema) as Resolver<OpportunityFormValues>,
    defaultValues: {
      name: '',
      customerId: '',
      amount: undefined,
      stage: 'lead_in',
      ownerId: null,
      expectedCloseDate: '',
      probability: undefined,
      remark: '',
      ...initialValues,
    },
  })

  async function handleSubmit(values: OpportunityFormValues) {
    const input: OpportunityInput = {
      name: values.name,
      customerId: values.customerId,
      amount: values.amount,
      stage: values.stage,
      ownerId: values.ownerId ?? null,
      expectedCloseDate: values.expectedCloseDate || undefined,
      probability: values.probability,
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
              <FormLabel>商机名 *</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="customerId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>客户 *</FormLabel>
              <FormControl>
                <CrmCustomerSelect
                  customers={customers}
                  value={field.value || null}
                  onChange={field.onChange}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-3">
          <FormField
            control={form.control}
            name="amount"
            render={({ field }) => (
              <FormItem>
                <FormLabel>金额 *</FormLabel>
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
            name="stage"
            render={({ field }) => (
              <FormItem>
                <FormLabel>阶段</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {Object.entries(OPPORTUNITY_STAGE_LABELS).map(([v, l]) => (
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

        <div className="grid grid-cols-2 gap-3">
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
          <FormField
            control={form.control}
            name="probability"
            render={({ field }) => (
              <FormItem>
                <FormLabel>赢单率(%)</FormLabel>
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
