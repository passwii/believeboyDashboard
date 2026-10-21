import { afterEach, describe, expect, it, vi } from 'vitest'

describe('CRM client runtime mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('未配置 NEXT_PUBLIC_CRM_API_MODE 时默认 http', async () => {
    vi.resetModules()
    const mod = await import('./crm-client-provider')
    expect(mod.__crmApiMode).toBe('http')
  })

  it('生产环境显式 mock 时拒绝启动', async () => {
    vi.stubEnv('NEXT_PUBLIC_CRM_API_MODE', 'mock')
    vi.stubEnv('NODE_ENV', 'production')
    vi.resetModules()
    await expect(import('./crm-client-provider')).rejects.toThrow(/mock/i)
  })
})
