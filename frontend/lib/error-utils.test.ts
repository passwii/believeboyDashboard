import { describe, expect, it } from 'vitest'

import { parseErrorText } from './error-utils'

const timeoutBody = JSON.stringify({
  detail: 'order_info_query_timeout: 订单查询超过服务端上限（15000ms），请收窄店铺或日期范围后重试',
})
const fallback = '请求失败'
const chineseTimeoutMessage = '订单查询超过服务端上限（15000ms），请收窄店铺或日期范围后重试'

describe('parseErrorText', () => {
  it('启用后剥除 detail 的内部 code 前缀', () => {
    expect(parseErrorText(timeoutBody, fallback, 504, { stripDetailCodePrefix: true })).toBe(
      chineseTimeoutMessage
    )
  })

  it('默认不剥除 detail 前缀，保持原有结果', () => {
    expect(parseErrorText(timeoutBody, fallback, 504)).toBe(
      'order_info_query_timeout: 订单查询超过服务端上限（15000ms），请收窄店铺或日期范围后重试'
    )
  })

  it('detail 没有 code 前缀时，无论开关状态都保持不变', () => {
    const body = JSON.stringify({ detail: '订单查询失败，请稍后重试' })

    expect(parseErrorText(body, fallback)).toBe('订单查询失败，请稍后重试')
    expect(parseErrorText(body, fallback, undefined, { stripDetailCodePrefix: true })).toBe(
      '订单查询失败，请稍后重试'
    )
  })

  it.each([
    ['object', { detail: { message: 'detail 对象信息' } }, 'detail 对象信息'],
    ['array', { detail: ['detail 数组信息'] }, fallback],
    ['null', { detail: null }, JSON.stringify({ detail: null })],
  ])('detail 为非字符串（%s）时不抛异常且保持既有行为', (_name, payload, expected) => {
    const body = JSON.stringify(payload)

    expect(() => parseErrorText(body, fallback, undefined, { stripDetailCodePrefix: true })).not.toThrow()
    expect(parseErrorText(body, fallback, undefined, { stripDetailCodePrefix: true })).toBe(expected)
  })

  it.each([
    ['message', { message: 'message: 保留 message 字段' }, 'message: 保留 message 字段'],
    ['error', { error: 'error: 保留 error 字段' }, 'error: 保留 error 字段'],
  ])('%s 字段路径不剥除 code 前缀', (_field, payload, expected) => {
    expect(parseErrorText(JSON.stringify(payload), fallback, undefined, { stripDetailCodePrefix: true })).toBe(
      expected
    )
  })
})
