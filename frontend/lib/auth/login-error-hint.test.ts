import { describe, expect, it } from 'vitest'

import {
  LOGIN_ERROR_HINT_COOKIE,
  clearLoginErrorHint,
  decodeLoginErrorHint,
  encodeLoginErrorHint,
  formatRequestId,
  readLoginErrorHint,
  readLoginErrorHintFromCookieString,
} from './login-error-hint'

describe('login-error-hint cookie 编解码', () => {
  it('往返保留 code / 请求 ID / 等待秒数', () => {
    const encoded = encodeLoginErrorHint({
      backendCode: 'LOGIN_RATE_LIMITED',
      requestId: '9f2c1a8e77aa',
      retryAfterSeconds: 30,
    })
    expect(encoded).toBeTruthy()
    expect(decodeLoginErrorHint(encoded)).toEqual({
      backendCode: 'LOGIN_RATE_LIMITED',
      requestId: '9f2c1a8e77aa',
      retryAfterSeconds: 30,
    })
  })

  it('空 hint 不写 cookie', () => {
    expect(encodeLoginErrorHint({})).toBeNull()
  })

  it('丢弃不合规字段，避免把任意文本渲染进页面', () => {
    const encoded = encodeLoginErrorHint({
      // 后端 code 只可能是大写枚举；其它形态一律丢弃
      backendCode: '<script>alert(1)</script>' as unknown as string,
      requestId: 'a b\tc' as unknown as string,
      retryAfterSeconds: -5,
    })
    expect(encoded).toBeNull()
  })

  it('解码时仍会过滤被篡改的字段', () => {
    // 手工构造一个夹带非法内容的 cookie 值
    expect(decodeLoginErrorHint('v1~<bad>~abc~10')).toEqual({
      backendCode: undefined,
      requestId: 'abc',
      retryAfterSeconds: 10,
    })
    expect(decodeLoginErrorHint('v1~LOGIN_X~<bad id>~')).toEqual({
      backendCode: 'LOGIN_X',
      requestId: undefined,
      retryAfterSeconds: undefined,
    })
    // 各字段全无效时才算空
    expect(decodeLoginErrorHint('v1~<bad>~<bad id>~-1')).toBeNull()
  })

  it('值是 cookie 安全字符（不被 Set-Cookie 二次编码）', () => {
    const encoded = encodeLoginErrorHint({
      backendCode: 'LOGIN_INTERNAL_ERROR',
      requestId: '9f2c1a8e77aa',
      retryAfterSeconds: 30,
    }) as string
    // 实证：JSON+encodeURIComponent 会被 Next 写成 %257B… 而客户端读不回来
    expect(encodeURIComponent(encoded)).toBe(encoded)
  })

  it('兼容被中间层再编码一次的 cookie 值', () => {
    const encoded = encodeLoginErrorHint({ backendCode: 'LOGIN_INTERNAL_ERROR', requestId: 'abc123' }) as string
    expect(decodeLoginErrorHint(encodeURIComponent(encoded))?.backendCode).toBe('LOGIN_INTERNAL_ERROR')
  })

  it('解析非法 cookie 值返回 null 而不是抛错', () => {
    expect(decodeLoginErrorHint('not-a-hint')).toBeNull()
    expect(decodeLoginErrorHint('')).toBeNull()
    expect(decodeLoginErrorHint(null)).toBeNull()
    expect(decodeLoginErrorHint('v1~~')).toBeNull()
    expect(decodeLoginErrorHint('v2~LOGIN_X~~5')).toBeNull()
  })

  it('从 cookie 字符串里挑出自己那一项', () => {
    const value = encodeLoginErrorHint({ backendCode: 'LOGIN_INTERNAL_ERROR', requestId: 'abc123' })
    const cookieString = `other=1; ${LOGIN_ERROR_HINT_COOKIE}=${value}; last=2`
    expect(readLoginErrorHintFromCookieString(cookieString)?.backendCode).toBe('LOGIN_INTERNAL_ERROR')
    expect(readLoginErrorHintFromCookieString('other=1')).toBeNull()
    expect(readLoginErrorHintFromCookieString(undefined)).toBeNull()
  })

  it('浏览器侧读取与清除走同一 cookie 名', () => {
    const value = encodeLoginErrorHint({ backendCode: 'LOGIN_INTERNAL_ERROR', requestId: 'abc12345' })
    document.cookie = `${LOGIN_ERROR_HINT_COOKIE}=${value}; Path=/`
    expect(readLoginErrorHint()?.requestId).toBe('abc12345')

    clearLoginErrorHint()
    expect(readLoginErrorHint()).toBeNull()
  })

  it('请求 ID 只展示前 8 位', () => {
    expect(formatRequestId('9f2c1a8e77aa4d3f')).toBe('9f2c1a8e')
    expect(formatRequestId('abc')).toBe('abc')
    expect(formatRequestId(undefined)).toBeNull()
    expect(formatRequestId('bad value')).toBeNull()
  })
})
