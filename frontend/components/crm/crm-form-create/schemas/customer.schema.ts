import { z } from 'zod'
import type { CustomerRating, CustomerStatus, CustomerSource } from '@/lib/crm/types/customer'

const RATINGS: [CustomerRating, ...CustomerRating[]] = ['A', 'B', 'C', 'D']
const STATUSES: [CustomerStatus, ...CustomerStatus[]] = ['active', 'lost', 'signed', 'on_hold']
const SOURCES: [CustomerSource, ...CustomerSource[]] = [
  'referral',
  'exhibition',
  'online_ad',
  'cold_call',
  'self_developed',
  'other',
]

/** 客户新建/编辑表单 schema（zod）。字段写死（D5），仅做必填 + 格式校验。 */
export const customerSchema = z.object({
  name: z.string().min(1, '客户名必填').max(100),
  shortName: z.string().max(100).optional().or(z.literal('')),
  industry: z.string().max(100).optional().or(z.literal('')),
  rating: z.enum(RATINGS, { message: '请选择等级' }),
  status: z.enum(STATUSES, { message: '请选择状态' }),
  source: z.enum(SOURCES, { message: '请选择来源' }),
  ownerId: z.string().min(1, '请选择负责人').or(z.null()),
  contactName: z.string().max(50).optional().or(z.literal('')),
  contactPhone: z
    .string()
    .max(20)
    .regex(/^[\d-+\s()]*$/, '电话格式不正确')
    .optional()
    .or(z.literal('')),
  contactEmail: z.string().email('邮箱格式不正确').optional().or(z.literal('')),
  address: z.string().max(200).optional().or(z.literal('')),
  website: z.string().max(200).optional().or(z.literal('')),
  annualRevenue: z.coerce.number().min(0).optional(),
  employeeCount: z.coerce.number().int().min(0).optional(),
  remark: z.string().max(500).optional().or(z.literal('')),
})

export type CustomerFormValues = z.infer<typeof customerSchema>
