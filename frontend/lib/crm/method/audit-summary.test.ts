import { describe, it, expect } from 'vitest'
import { resolveAuditSummary } from './audit-summary'
import type { User } from '@/lib/crm/types'

const ALICE_ID = 'e86f15be-357e-4659-8bb5-aa2c698388a5'
const BOB_ID = '497d5d63-9162-4927-b3e7-3498e73b575c'

function user(id: string, name: string): User {
  return {
    id,
    name,
    email: `${name.toLowerCase()}@believeboy.com`,
    roleType: 'admin',
    isActive: true,
  }
}

const USERS = [user(ALICE_ID, 'Buck'), user(BOB_ID, 'DamonROCK')]

describe('resolveAuditSummary（BLF-1440 审计摘要 uuid → 用户名）', () => {
  it('负责人变更的 uuid 双子还原成姓名', () => {
    expect(
      resolveAuditSummary(`负责人: ${ALICE_ID}→${BOB_ID}`, USERS)
    ).toBe('负责人: Buck→DamonROCK')
  })

  it('同一条摘要里多个 uuid（含其它字段）都还原', () => {
    expect(
      resolveAuditSummary(
        `负责人: ${ALICE_ID}→${BOB_ID}; 客户名: 旧→新`,
        USERS
      )
    ).toBe('负责人: Buck→DamonROCK; 客户名: 旧→新')
  })

  it('大小写不同的 uuid 也能命中', () => {
    expect(
      resolveAuditSummary(`负责人: 空→${ALICE_ID.toUpperCase()}`, USERS)
    ).toBe('负责人: 空→Buck')
  })

  it('用户目录里查不到的 uuid 原样保留（不丢审计信息）', () => {
    const unknown = '11111111-2222-3333-4444-555555555555'
    expect(resolveAuditSummary(`负责人: 空→${unknown}`, USERS)).toBe(
      `负责人: 空→${unknown}`
    )
  })

  it('没有 uuid 的摘要原样返回', () => {
    expect(resolveAuditSummary('新建客户', USERS)).toBe('新建客户')
  })

  it('用户目录为空 / 摘要为空时安全降级', () => {
    expect(resolveAuditSummary(`负责人: ${ALICE_ID}→${BOB_ID}`, [])).toBe(
      `负责人: ${ALICE_ID}→${BOB_ID}`
    )
    expect(resolveAuditSummary(null, USERS)).toBe('')
    expect(resolveAuditSummary(undefined, USERS)).toBe('')
  })
})
