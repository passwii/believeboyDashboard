import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createSubscription,
  fetchLedger,
  parseApiErrorText,
  pollDeliveryLogStatus,
  resendLedgerEntry,
  sendTestEmail,
  updateSubscription,
} from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('parseApiErrorText', () => {
  it('解析 detail 字符串并翻译后端英文错误', () => {
    expect(parseApiErrorText('{"detail":"email is required"}', 422, '测试邮件发送失败')).toBe(
      '请填写邮箱地址后再发送测试邮件'
    )
  })

  it('解析 FastAPI detail 数组，不把 JSON 暴露给用户', () => {
    const body = JSON.stringify({
      detail: [
        { loc: ['body', 'email'], msg: 'email is required', type: 'missing' },
        { loc: ['body', 'frequency'], msg: 'field required', type: 'missing' },
      ],
    })
    const message = parseApiErrorText(body, 422, '请求失败')
    expect(message).toBe('请填写邮箱地址后再发送测试邮件；必填项缺失，请检查后重试')
    expect(message).not.toContain('{')
  })

  it('HTML 错误页只回落到中文状态文案，不原样透出 HTML', () => {
    const message = parseApiErrorText(
      '<html><body><h1>Internal Server Error</h1></body></html>',
      500,
      '发送失败'
    )
    expect(message).toBe('服务暂时不可用，请稍后重试')
    expect(message).not.toContain('<')
  })

  it('未知英文细节回落到状态级中文文案', () => {
    expect(parseApiErrorText('{"detail":"bridge exploded"}', 409, '操作失败')).toBe(
      '当前状态不允许该操作，请刷新后重试'
    )
  })

  it('中文 detail 原样保留（可直接操作）', () => {
    expect(
      parseApiErrorText('{"detail":"周报最早可在周一 16:00 发送"}', 422, '操作失败')
    ).toBe('周报最早可在周一 16:00 发送')
  })
})

describe('sendTestEmail', () => {
  it('422 email is required 不再静默，返回中文可操作提示', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ detail: 'email is required' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        })
    )

    await expect(
      sendTestEmail({
        email: '',
        frequency: 'daily',
        project_ids: '*',
        country: 'US',
        ai_model: null,
      })
    ).resolves.toEqual({
      success: false,
      message: '请填写邮箱地址后再发送测试邮件',
    })
  })

  it('422 detail 数组也透出可读文案', async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            detail: [{ loc: ['body', 'email'], msg: 'field required', type: 'missing' }],
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        )
    )

    const result = await sendTestEmail({
      email: 'ops@example.com',
      frequency: 'daily',
      project_ids: '*',
      country: 'US',
      ai_model: null,
    })
    expect(result.success).toBe(false)
    expect(result.message).toBe('必填项缺失，请检查后重试')
  })

  it('500 HTML 错误页不把 HTML 抛给用户', async () => {
    installFetch(() => new Response('<html>Internal Server Error</html>', { status: 500 }))

    const result = await sendTestEmail({
      email: 'ops@example.com',
      frequency: 'daily',
      project_ids: '*',
      country: 'US',
      ai_model: null,
    })
    expect(result.success).toBe(false)
    expect(result.message).toBe('服务暂时不可用，请稍后重试')
    expect(result.message).not.toContain('<html')
  })

  it('2xx 且 success=false 时保留后端中文失败原因', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ success: false, message: '发送失败: 邮件服务超时' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    )

    const result = await sendTestEmail({
      email: 'ops@example.com',
      frequency: 'daily',
      project_ids: '*',
      country: 'US',
      ai_model: null,
    })
    expect(result).toEqual({ success: false, message: '发送失败: 邮件服务超时' })
  })

  it('2xx 且 success=true 时返回后端的成功文案', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ success: true, message: '测试报告已发送到 ops@example.com' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    )

    const result = await sendTestEmail({
      email: 'ops@example.com',
      frequency: 'daily',
      project_ids: '*',
      country: 'US',
      ai_model: null,
    })
    expect(result.success).toBe(true)
    expect(result.message).toBe('测试报告已发送到 ops@example.com')
  })
})

describe('createSubscription', () => {
  it('无邮箱创建成功，请求体显式携带 email=null（后端契约允许）', async () => {
    const fetchMock = installFetch(
      () => new Response(JSON.stringify({ id: 42 }), { status: 201 })
    )

    const result = await createSubscription({
      email: null,
      project_ids: '*',
      country: 'US',
      frequency: 'daily',
      dispatch_hour: 15,
      dispatch_minute: 10,
      dispatch_weekday: null,
      dispatch_day: null,
      ai_model: null,
    })

    expect(result).toEqual({ ok: true })
    const [, init] = fetchMock.mock.calls[0]!
    expect(JSON.parse(String(init?.body))).toMatchObject({
      email: null,
      project_ids: '*',
      frequency: 'daily',
    })
  })

  it('422 detail 数组转为中文错误文案', async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({
            detail: [{ loc: ['body', 'dispatch_day'], msg: 'field required', type: 'missing' }],
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        )
    )

    const result = await createSubscription({
      email: null,
      project_ids: '*',
      country: 'US',
      frequency: 'monthly',
      dispatch_hour: 15,
      dispatch_minute: 0,
      dispatch_weekday: null,
      dispatch_day: null,
      ai_model: null,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('必填项缺失，请检查后重试')
    expect(result.error).not.toContain('detail')
  })
})

describe('fetchLedger', () => {
  it('非 2xx 时把后端 detail 翻成中文，不把原始 JSON 交给错误态', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ detail: 'scheduled report store not configured' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
    )
    const onError = vi.fn()

    await fetchLedger(
      {
        startDate: '2026-11-01',
        endDate: '2026-11-18',
        frequency: 'all',
        statusFilter: 'all',
        email: '',
      },
      vi.fn(),
      onError
    )

    expect(onError).toHaveBeenCalledWith('定时报告服务未配置，请联系管理员')
    expect(onError.mock.calls[0]![0]).not.toContain('{')
  })
})

describe('pollDeliveryLogStatus', () => {
  it('按 limit=50 查询并按 delivery_log_id 匹配，避免准备中无限转圈', async () => {
    const fetchMock = installFetch(
      () =>
        new Response(
          JSON.stringify({
            items: [
              { id: 8, stage: 'done' },
              { id: 7, stage: 'done' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    )
    const onStage = vi.fn()
    const onDone = vi.fn()

    pollDeliveryLogStatus('lk-1', 7, onStage, onDone, vi.fn(), 10, 0)

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith('lk-1'))
    expect(onStage).toHaveBeenCalledWith('lk-1', 'done')
    const [url] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('delivery-logs?limit=50')
  })

  it('stage 停滞超过阈值时通知超时，而不是永久停在「准备中」', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ items: [{ id: 7, stage: 'preparing' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    )
    const onStage = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()

    pollDeliveryLogStatus('lk-1', 7, onStage, onDone, onError, 10, 0)

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('lk-1', 'timeout'))
    expect(onDone).not.toHaveBeenCalled()
    expect(onStage).toHaveBeenCalledWith('lk-1', 'preparing')
  })

  it('stage=failed 时通知失败原因而不是当作完成', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ items: [{ id: 7, stage: 'failed' }] }), { status: 200 })
    )
    const onDone = vi.fn()
    const onError = vi.fn()

    pollDeliveryLogStatus('lk-1', 7, vi.fn(), onDone, onError, 10, 1000)

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('lk-1', 'failed'))
    expect(onDone).not.toHaveBeenCalled()
  })
})

describe('updateSubscription / resendLedgerEntry 契约', () => {
  it('无邮箱编辑保存时请求体显式携带 email=null', async () => {
    const fetchMock = installFetch(
      () => new Response(JSON.stringify({ id: 42 }), { status: 200 })
    )

    const result = await updateSubscription(42, {
      email: null,
      project_ids: '*',
      country: 'US',
      frequency: 'daily',
      dispatch_hour: 15,
      dispatch_minute: 10,
      dispatch_weekday: null,
      dispatch_day: null,
      ai_model: null,
    })

    expect(result).toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('/subscriptions/42')
    expect(JSON.parse(String(init?.body))).toMatchObject({ email: null })
  })

  it('resend 4xx 的 detail 转为中文，不把原始 JSON 抛给用户', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ detail: 'ledger entry already sent' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        })
    )

    const result = await resendLedgerEntry('7:2026-11-18', true, null)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('该记录已发送成功，无需重新生成')
    expect(result.error).not.toContain('detail')
  })
})
