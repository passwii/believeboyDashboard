/**
 * BLF-1404 复核：上传上限常量的**模式相关性**。
 *
 * 关键事实：20MB 是**后端业务上限**，不是「生产链路可用上限」。
 * 生产前端在 Vercel，函数网关对请求体有 4.5MB 硬上限
 * （2026-10-20 生产实测：4,400,000 B → 401；4,500,000 B → 413 FUNCTION_PAYLOAD_TOO_LARGE）。
 *
 * → 预校验上限必须随 CRM 客户端模式走：
 *   - `http`（生产）→ 经 Next 代理 → 受网关限制 → 4MB；
 *   - `mock`（默认）→ 只进 localStorage，不过网关 → 20MB。
 *
 * 这条用例钉住「两个上限的语义别被混用」：
 * 提示文案用**后端业务上限**（20MB，说的是后端能收多大）；
 * 预校验用**链路有效上限**（http 模式 4MB，说的是这条路上能传多大）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CRM_USES_REAL_BACKEND,
  PROPOSAL_EFFECTIVE_UPLOAD_LIMIT_MB,
  PROPOSAL_MAX_UPLOAD_MB,
  PROPOSAL_UPLOAD_GATEWAY_LIMIT_MB,
} from './proposal'

describe('客户方案上传上限常量', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('后端业务上限 = 20MB（与后端 crm_proposal_max_bytes 同口径）', () => {
    expect(PROPOSAL_MAX_UPLOAD_MB).toBe(20)
  })

  it('平台网关上限 = 4MB（Vercel 4.5MB 硬上限留余量）', () => {
    expect(PROPOSAL_UPLOAD_GATEWAY_LIMIT_MB).toBe(4)
  })

  it('mock 模式（默认）→ 预校验用后端业务上限 20MB', async () => {
    vi.stubEnv('NEXT_PUBLIC_CRM_API_MODE', 'mock')
    vi.resetModules()
    // 重新导入以拿到新的模块级求值结果
    const mod = await import('./proposal')
    expect(mod.CRM_USES_REAL_BACKEND).toBe(false)
    expect(mod.PROPOSAL_EFFECTIVE_UPLOAD_LIMIT_MB).toBe(20)
  })

  it('http 模式（生产）→ 预校验用网关有效上限 4MB', async () => {
    vi.stubEnv('NEXT_PUBLIC_CRM_API_MODE', 'http')
    vi.resetModules()
    const mod = await import('./proposal')
    expect(mod.CRM_USES_REAL_BACKEND).toBe(true)
    expect(mod.PROPOSAL_EFFECTIVE_UPLOAD_LIMIT_MB).toBe(4)
  })
})
