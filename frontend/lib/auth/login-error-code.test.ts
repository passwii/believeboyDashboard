import { describe, expect, it } from 'vitest'

import {
  pageCodeFromBackendCode,
  pageCodeFromStatus,
  resolveLoginPageErrorCode,
} from './login-error-code'

describe('pageCodeFromBackendCode', () => {
  it('把后端稳定枚举映射成页面 code', () => {
    expect(pageCodeFromBackendCode('LOGIN_INVALID_CREDENTIALS')).toBe('invalid_credentials')
    expect(pageCodeFromBackendCode('LOGIN_ACCOUNT_DISABLED')).toBe('account_disabled')
    expect(pageCodeFromBackendCode('LOGIN_RATE_LIMITED')).toBe('rate_limited')
    expect(pageCodeFromBackendCode('LOGIN_INTERNAL_ERROR')).toBe('internal_error')
    expect(pageCodeFromBackendCode('LOGIN_INVALID_CLIENT_ID')).toBe('invalid_client_id')
  })

  it('大小写不敏感，未知 / 空值返回 undefined', () => {
    expect(pageCodeFromBackendCode('login_account_disabled')).toBe('account_disabled')
    expect(pageCodeFromBackendCode('LOGIN_FUTURE_REASON')).toBeUndefined()
    expect(pageCodeFromBackendCode('')).toBeUndefined()
    expect(pageCodeFromBackendCode(undefined)).toBeUndefined()
  })
})

describe('pageCodeFromStatus（旧后端兜底）', () => {
  it('500 不再归成密码错', () => {
    expect(pageCodeFromStatus(500)).toBe('internal_error')
    expect(pageCodeFromStatus(502)).toBe('internal_error')
  })

  it('401 结合 detail 区分停用与凭据错误', () => {
    expect(pageCodeFromStatus(401, 'Invalid credentials')).toBe('invalid_credentials')
    expect(pageCodeFromStatus(401, 'Account disabled')).toBe('account_disabled')
  })

  it('429 / 400 各有专属 code', () => {
    expect(pageCodeFromStatus(429)).toBe('rate_limited')
    expect(pageCodeFromStatus(400)).toBe('invalid_client_id')
  })
})

describe('resolveLoginPageErrorCode', () => {
  it('我们自己的页面 code 原样命中', () => {
    expect(resolveLoginPageErrorCode('invalid_credentials')).toBe('invalid_credentials')
    expect(resolveLoginPageErrorCode('RATE_LIMITED')).toBe('rate_limited')
    expect(resolveLoginPageErrorCode('network_error')).toBe('network_error')
  })

  it('Auth.js 默认 credentials（含空值）走旧兜底文案', () => {
    expect(resolveLoginPageErrorCode('credentials')).toBe('generic_credentials')
    expect(resolveLoginPageErrorCode(undefined)).toBe('generic_credentials')
  })

  it('其它未知 code 归成 unknown，不冒充密码错误', () => {
    expect(resolveLoginPageErrorCode('Configuration')).toBe('unknown')
    expect(resolveLoginPageErrorCode('some_new_code')).toBe('unknown')
  })
})
