import { z } from 'zod'
import type { OpportunityStage } from '@/lib/crm/types/opportunity'

const STAGES: [OpportunityStage, ...OpportunityStage[]] = [
  'lead_in',
  'qualified',
  'proposal',
  'negotiation',
  'won',
  'lost',
]

/** 商机新建/编辑表单 schema（zod）。字段写死（D5），仅做必填 + 格式校验。 */
export const opportunitySchema = z.object({
  name: z.string().min(1, '商机名必填').max(100),
  customerId: z.string().min(1, '请选择客户'),
  amount: z.coerce.number().min(0, '金额不能为负'),
  stage: z.enum(STAGES, { message: '请选择阶段' }),
  ownerId: z.string().min(1, '请选择负责人').or(z.null()),
  expectedCloseDate: z.string().max(20).optional().or(z.literal('')),
  probability: z.coerce.number().min(0).max(100).optional(),
  remark: z.string().max(500).optional().or(z.literal('')),
})

export type OpportunityFormValues = z.infer<typeof opportunitySchema>
