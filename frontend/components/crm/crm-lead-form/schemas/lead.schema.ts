import { z } from 'zod'
import type { LeadStatus, LeadIntent } from '@/lib/crm/types/lead'
import type { CustomerSource } from '@/lib/crm/types/customer'

const STATUSES: [LeadStatus, ...LeadStatus[]] = [
  'new',
  'contacting',
  'qualified',
  'converted',
  'discarded',
]
const INTENTS: [LeadIntent, ...LeadIntent[]] = ['high', 'medium', 'low']
const SOURCES: [CustomerSource, ...CustomerSource[]] = [
  'referral',
  'exhibition',
  'online_ad',
  'cold_call',
  'self_developed',
  'other',
]

/** 线索新建/编辑表单 schema（zod）。字段写死（D5），仅做必填 + 格式校验。 */
export const leadSchema = z.object({
  name: z.string().min(1, '联系人必填').max(100),
  company: z.string().max(100).optional().or(z.literal('')),
  phone: z
    .string()
    .max(20)
    .regex(/^[\d-+\s()]*$/, '电话格式不正确')
    .optional()
    .or(z.literal('')),
  email: z.string().email('邮箱格式不正确').optional().or(z.literal('')),
  wechat: z.string().max(50).optional().or(z.literal('')),
  source: z.enum(SOURCES, { message: '请选择来源' }),
  status: z.enum(STATUSES, { message: '请选择状态' }),
  intent: z.enum(INTENTS, { message: '请选择意向' }),
  ownerId: z.string().min(1, '请选择负责人').or(z.null()),
  expectedAmount: z.coerce.number().min(0).optional(),
  expectedCloseDate: z.string().max(20).optional().or(z.literal('')),
  remark: z.string().max(500).optional().or(z.literal('')),
})

export type LeadFormValues = z.infer<typeof leadSchema>
