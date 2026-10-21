/**
 * 客户方案上传上限 / 分段阈值 / 运行时模式常量。
 *
 * 2026-10-21 分段方案：
 * - 运行时默认 `http`；生产显式 `mock` 由 provider 拒绝；
 * - 预校验上限始终 20MB（分段不再受 Vercel 4.5MB 网关限制）；
 * - > 4MB 由前端走分段（阈值常量）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CRM_USES_REAL_BACKEND,
  PROPOSAL_CHUNK_THRESHOLD_BYTES,
  PROPOSAL_EFFECTIVE_UPLOAD_LIMIT_MB,
  PROPOSAL_MAX_UPLOAD_MB,
} from './proposal'

describe('客户方案上传常量', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('后端业务上限 = 20MB', () => {
    expect(PROPOSAL_MAX_UPLOAD_MB).toBe(20)
  })

  it('分段阈值 = 4MB（低于 Vercel 4.5MB 网关）', () => {
    expect(PROPOSAL_CHUNK_THRESHOLD_BYTES).toBe(4 * 1024 * 1024)
  })

  it('默认 http，预校验上限 20MB', () => {
    expect(CRM_USES_REAL_BACKEND).toBe(true)
    expect(PROPOSAL_EFFECTIVE_UPLOAD_LIMIT_MB).toBe(20)
  })

  it('显式 mock 仍可用（测试配置），预校验上限同为 20MB', async () => {
    vi.stubEnv('NEXT_PUBLIC_CRM_API_MODE', 'mock')
    vi.resetModules()
    const mod = await import('./proposal')
    expect(mod.CRM_USES_REAL_BACKEND).toBe(false)
    expect(mod.PROPOSAL_EFFECTIVE_UPLOAD_LIMIT_MB).toBe(20)
  })
})
