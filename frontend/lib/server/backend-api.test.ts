import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import { BackendHttpError, backendFetchJson } from './backend-api'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) },
  })
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected promise to reject')
}

describe('backendFetchJson 失败响应契约（BLF-1383）', () => {
  it('把 status / code / request_id / retry_after_seconds 带到错误对象上', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          detail: 'Too many login attempts. Please try again later.',
          code: 'LOGIN_RATE_LIMITED',
          message: '登录失败次数过多，请在 30 秒后重试。',
          request_id: 'abc123',
          retry_after_seconds: 30,
        },
        { status: 429, headers: { 'X-Request-Id': 'abc123', 'Retry-After': '30' } },
      ),
    )

    const err = await catchError(backendFetchJson('/api/v1/auth/login'))

    expect(err).toBeInstanceOf(BackendHttpError)
    const httpError = err as BackendHttpError
    expect(httpError).toBeInstanceOf(Error)
    expect(httpError.status).toBe(429)
    expect(httpError.code).toBe('LOGIN_RATE_LIMITED')
    expect(httpError.requestId).toBe('abc123')
    expect(httpError.retryAfterSeconds).toBe(30)
    expect(httpError.message).toBe('登录失败次数过多，请在 30 秒后重试。')
  })

  it('纯文本 500（旧后端）仍给出状态码，不因 JSON 解析失败而丢信息', async () => {
    fetchMock.mockResolvedValue(
      new Response('Internal Server Error', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      }),
    )

    const err = (await catchError(backendFetchJson('/api/v1/auth/login'))) as BackendHttpError

    expect(err).toBeInstanceOf(BackendHttpError)
    expect(err.status).toBe(500)
    expect(err.code).toBeUndefined()
    expect(err.requestId).toBeUndefined()
    expect(err.message).toContain('500')
  })

  it('body 缺 retry_after_seconds 时回落 Retry-After 头', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: 'Too many login attempts' }, { status: 429, headers: { 'Retry-After': '45' } }),
    )

    const err = (await catchError(backendFetchJson('/api/v1/auth/login'))) as BackendHttpError

    expect(err.retryAfterSeconds).toBe(45)
  })

  it('message 优先于 detail，并保持既有调用方的 err.message 语义', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { detail: 'Account disabled', code: 'LOGIN_ACCOUNT_DISABLED', message: '该账号已被停用。' },
        { status: 401 },
      ),
    )

    const err = (await catchError(backendFetchJson('/api/v1/auth/login'))) as BackendHttpError

    expect(err.message).toBe('该账号已被停用。')
  })

  it('成功响应照常返回解析后的 JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'u1', is_active: true }))

    await expect(backendFetchJson<{ id: string }>('/api/v1/auth/login')).resolves.toEqual({
      id: 'u1',
      is_active: true,
    })
  })

  it('2xx 无 body（204）返回 undefined 而不是抛解析错误', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    await expect(backendFetchJson('/x')).resolves.toBeUndefined()
  })
})
