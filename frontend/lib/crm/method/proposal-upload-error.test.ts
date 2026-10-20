import { describe, expect, it } from 'vitest'

import { ApiError } from '@/lib/crm/api/http-crm-client'
import { PROPOSAL_MAX_UPLOAD_MB } from '@/lib/crm/constants/proposal'
import { proposalUploadErrorCopy } from './proposal-upload-error'

const FALLBACK = { title: '创建失败', message: '创建方案失败' }

describe('proposalUploadErrorCopy', () => {
  it('413 → 提示文件超上限（并给出上限值，别让用户猜）', () => {
    const copy = proposalUploadErrorCopy(new ApiError(413, '文件超过 20971520 字节上限'), FALLBACK)
    expect(copy.title).toBe('文件过大')
    expect(copy.message).toContain(`${PROPOSAL_MAX_UPLOAD_MB}MB`)
    expect(copy.message).toContain('压缩')
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
