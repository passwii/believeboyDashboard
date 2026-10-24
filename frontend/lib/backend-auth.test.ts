import type { Session } from 'next-auth'
import { describe, expect, it } from 'vitest'

import { buildBackendClientHeaders } from './backend-auth'

/**
 * BLF-1441：`X-Operator` / `X-User-Name` 的口径。
 *
 * 这两个头是所有「操作人 / 创建人 / 更新人」快照的来源，也是项目鉴权键
 * （后端拿它匹配 `projects.project_operator`），所以口径必须与
 * `user_accounts.full_name` 完全一致，不能有第二套兜底。
 */

function sessionWith(user: Record<string, unknown>): Session {
  return { user, expires: '2099-01-01T00:00:00.000Z' } as unknown as Session
}

function headersFor(user: Record<string, unknown>): Headers {
  return buildBackendClientHeaders(sessionWith(user))
}

describe('buildBackendClientHeaders · X-Operator / X-User-Name', () => {
  it('发 full_name（URL 编码），不是运营名也不是登录名', () => {
    const headers = headersFor({
      id: 'u1',
      name: 'Yawei',
      email: 'yawei@believeboy.com',
      fullName: '纪亚伟',
      operatorNameZh: '运营A',
      roleType: 'admin',
    })

    expect(decodeURIComponent(headers.get('X-Operator')!)).toBe('纪亚伟')
    expect(decodeURIComponent(headers.get('X-User-Name')!)).toBe('纪亚伟')
    expect(headers.get('X-User-Name')).toBe(headers.get('X-Operator'))
  })

  it('full_name 为空时两个头都不发（不回落登录名，也不发空头）', () => {
    const headers = headersFor({
      id: 'u1',
      name: 'DamonROCK',
      email: 'rock@believeboy.com',
      fullName: null,
      operatorNameZh: '运营A',
      roleType: 'operator',
    })

    expect(headers.get('X-Operator')).toBeNull()
    expect(headers.get('X-User-Name')).toBeNull()
    // 身份相关的其它头照常发送，401 只由「没有名字」这一件事引起。
    expect(headers.get('X-User-Id')).toBe('u1')
    expect(headers.get('X-User-Email')).toBe('rock%40believeboy.com')
  })

  it('过渡期：旧 token 没有 fullName 键时仍发旧值，避免升级瞬间 401', () => {
    const headers = headersFor({
      id: 'u1',
      name: 'Yawei',
      email: 'yawei@believeboy.com',
      operatorNameZh: '纪亚伟',
      roleType: 'admin',
    })

    expect(decodeURIComponent(headers.get('X-Operator')!)).toBe('纪亚伟')
  })

  it('full_name 只有空白时不发头', () => {
    const headers = headersFor({ id: 'u1', name: 'Yawei', fullName: '   ' })

    expect(headers.get('X-Operator')).toBeNull()
    expect(headers.get('X-User-Name')).toBeNull()
  })

  it('没有会话时不发任何身份头', () => {
    const headers = buildBackendClientHeaders(null)

    expect(headers.get('X-Operator')).toBeNull()
    expect(headers.get('X-User-Name')).toBeNull()
    expect(headers.get('X-User-Id')).toBeNull()
  })

  it('管理员标记与角色头不受显示名口径影响', () => {
    const headers = headersFor({
      id: 'u1',
      fullName: '纪亚伟',
      roleType: 'admin',
      isAdmin: true,
      sessionId: 's1',
    })

    expect(headers.get('X-Is-Admin')).toBe('true')
    expect(headers.get('X-Role-Type')).toBe('admin')
    expect(headers.get('X-Session-Id')).toBe('s1')
  })
})
