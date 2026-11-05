import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getBackendBaseUrl, getBackendPublicBaseUrl } from './backend-api'

beforeEach(() => {
  vi.stubEnv('BACKEND_INTERNAL_URL', '')
  vi.stubEnv('BACKEND_PUBLIC_API_BASE_URL', '')
  vi.stubEnv('BACKEND_API_BASE_URL', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('backend base URL selection', () => {
  it('prefers loopback for server-to-server requests', () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', 'http://127.0.0.1:8100')
    vi.stubEnv('BACKEND_API_BASE_URL', 'https://dash-api.believeboy.com')

    expect(getBackendBaseUrl()).toBe('http://127.0.0.1:8100')
  })

  it('keeps the public URL for browser-facing metadata', () => {
    vi.stubEnv('BACKEND_INTERNAL_URL', 'http://127.0.0.1:8100')
    vi.stubEnv('BACKEND_PUBLIC_API_BASE_URL', 'https://dash-api.believeboy.com')

    expect(getBackendPublicBaseUrl()).toBe('https://dash-api.believeboy.com')
  })

  it('falls back to BACKEND_API_BASE_URL when split values are absent', () => {
    vi.stubEnv('BACKEND_API_BASE_URL', 'https://dash-api.believeboy.com/')

    expect(getBackendBaseUrl()).toBe('https://dash-api.believeboy.com')
    expect(getBackendPublicBaseUrl()).toBe('https://dash-api.believeboy.com')
  })
})
