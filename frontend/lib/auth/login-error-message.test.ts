import { describe, expect, it } from 'vitest'

import { buildLoginErrorMessage } from './login-error-message'
import type { LoginErrorHint } from './login-error-hint'

const hint: LoginErrorHint = {
  backendCode: 'LOGIN_INTERNAL_ERROR',
  requestId: '9f2c1a8e77aa4d3f9e0b1c2d3e4f5a6b',
}

describe('buildLoginErrorMessage', () => {
  it('密码错误只说密码错误', () => {
    expect(buildLoginErrorMessage({ code: 'invalid_credentials' })).toBe(
      '邮箱或密码错误，请检查大小写与键盘输入法后重试。',
    )
  })

  it('账号停用与密码错误分开', () => {
    const message = buildLoginErrorMessage({ code: 'account_disabled' })
    expect(message).toContain('账号已停用')
    expect(message).not.toContain('邮箱或密码错误')
  })

  it('限流带剩余秒数时倒计时，拿不到时退化成静态文案', () => {
    expect(buildLoginErrorMessage({ code: 'rate_limited', rateLimitRemainingSeconds: 42 })).toBe(
      '登录失败次数过多，请 42 秒后重试。',
    )
    expect(buildLoginErrorMessage({ code: 'rate_limited', rateLimitRemainingSeconds: 0 })).toBe(
      '登录失败次数过多，请稍后重试。',
    )
    expect(buildLoginErrorMessage({ code: 'rate_limited' })).toBe('登录失败次数过多，请稍后重试。')
  })

  it('后端内部错误附错误码与请求 ID 前 8 位，便于报障定位', () => {
    const message = buildLoginErrorMessage({ code: 'internal_error', hint })
    expect(message).toContain('登录服务内部错误')
    expect(message).toContain('错误码 LOGIN_INTERNAL_ERROR')
    expect(message).toContain('请求 ID 9f2c1a8e）')
    expect(message).not.toContain('9f2c1a8e77aa4d3f')
    expect(message).not.toContain('无法连接到服务器')
  })

  it('网络错误保留既有可恢复文案', () => {
    expect(buildLoginErrorMessage({ code: 'network_error' })).toBe(
      '无法连接到服务器，请检查后端服务是否启动。',
    )
  })

  it('Auth.js 默认 credentials 沿用旧兜底文案', () => {
    expect(buildLoginErrorMessage({ code: 'generic_credentials' })).toBe('邮箱或密码错误，或账号已停用。')
  })

  it('未知 code 不归因为密码错误', () => {
    const message = buildLoginErrorMessage({ code: 'unknown' })
    expect(message).toContain('登录未成功，请稍后重试')
    expect(message).not.toContain('邮箱或密码错误')
  })

  it('没有排查线索时不留空括号', () => {
    const message = buildLoginErrorMessage({ code: 'internal_error', hint: null })
    expect(message).toBe('登录服务内部错误，请稍后重试。')
    expect(message).not.toContain('（）')
  })
})
