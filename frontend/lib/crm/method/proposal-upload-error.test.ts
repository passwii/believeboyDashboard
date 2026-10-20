import { describe, expect, it } from 'vitest'

import { ApiError } from '@/lib/crm/api/http-crm-client'
import {
  PROPOSAL_MAX_UPLOAD_MB,
  PROPOSAL_UPLOAD_GATEWAY_LIMIT_MB,
} from '@/lib/crm/constants/proposal'
import { proposalUploadErrorCopy } from './proposal-upload-error'

const FALLBACK = { title: '创建失败', message: '创建方案失败' }

describe('proposalUploadErrorCopy', () => {
  it('后端 413（JSON 错误体）→ 提示后端 20MB 业务上限', () => {
    const copy = proposalUploadErrorCopy(
      new ApiError(413, '文件超过 20971520 字节上限', { detail: '文件超过 20971520 字节上限' }),
      FALLBACK
    )
    expect(copy.title).toBe('文件过大')
    expect(copy.message).toContain(`${PROPOSAL_MAX_UPLOAD_MB}MB`)
    expect(copy.message).toContain('压缩')
  })

  /**
   * BLF-1404 复核（Codex P1）：**平台网关 413 ≠ 后端 413**。
   *
   * Vercel 函数网关 4.5MB 硬上限超限时，返回的是**纯文本**体
   * （`Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE`）→ `res.json()` 抛错
   * → `ApiError.body` 为 `undefined`；而应用代码一行都没跑。
   *
   * 旧实现对两者一律说「超过 20MB」→ 用户传 5MB 也看到「超过 20MB」，
   * 且被引向「再压缩」这个**无效**动作（压到 10MB 依然被网关拒）。
   */
  it('平台网关 413（非 JSON 错误体）→ 提示平台体积限制，绝不说 20MB', () => {
    const copy = proposalUploadErrorCopy(
      // body 为 undefined = 非 JSON 错误体 = 网关层拒绝
      new ApiError(413, 'CRM 请求失败（413）'),
      FALLBACK
    )
    expect(copy.title).toBe('文件过大')
    expect(copy.message).toContain(`${PROPOSAL_UPLOAD_GATEWAY_LIMIT_MB}MB`)
    // 关键断言：不能拿 20MB 口径误导用户
    expect(copy.message).not.toContain(`${PROPOSAL_MAX_UPLOAD_MB}MB`)
    expect(copy.message).not.toContain('20MB')
  })

  it('网关 413 即使带 body 但不是 JSON 对象，也走平台口径', () => {
    // body 是字符串 / 数字时也不是后端 JSON 错误体 → 不该用 20MB 口径
    const copy = proposalUploadErrorCopy(new ApiError(413, 'too large', 'FUNCTION_PAYLOAD_TOO_LARGE'), FALLBACK)
    expect(copy.message).toContain(`${PROPOSAL_UPLOAD_GATEWAY_LIMIT_MB}MB`)
    expect(copy.message).not.toContain('20MB')
  })

  it('504 → 提示超时并建议重试', () => {
    const copy = proposalUploadErrorCopy(
      new ApiError(504, '请求后端服务超时，请稍后重试。'),
      FALLBACK
    )
    expect(copy.title).toBe('上传超时')
    expect(copy.message).toContain('重试')
  })

  it('其它 4xx/5xx → 保留后端 detail 原文（不覆盖可操作信息）', () => {
    const copy = proposalUploadErrorCopy(
      new ApiError(400, '不支持的文件类型：仅接受单个 HTML 文件（.html / .htm）'),
      FALLBACK
    )
    expect(copy.title).toBe('创建失败')
    expect(copy.message).toBe('不支持的文件类型：仅接受单个 HTML 文件（.html / .htm）')
  })

  it('401/403 → 保留后端 message，但用回退标题', () => {
    const copy = proposalUploadErrorCopy(new ApiError(403, '无权限'), FALLBACK)
    expect(copy.title).toBe('创建失败')
    expect(copy.message).toBe('无权限')
  })

  it('网络层错误（无 status 的 Error）→ 保留原 message', () => {
    const copy = proposalUploadErrorCopy(new Error('网络错误：fetch failed'), FALLBACK)
    expect(copy.title).toBe('创建失败')
    expect(copy.message).toBe('网络错误：fetch failed')
  })

  it('未知异常（null / 非 Error）→ 落回退文案', () => {
    expect(proposalUploadErrorCopy(null, FALLBACK)).toEqual(FALLBACK)
    expect(proposalUploadErrorCopy('boom', FALLBACK)).toEqual(FALLBACK)
  })

  it('ApiError 但 message 为空 → 落回退文案', () => {
    const copy = proposalUploadErrorCopy(new ApiError(500, ''), FALLBACK)
    expect(copy.message).toBe(FALLBACK.message)
  })
})
