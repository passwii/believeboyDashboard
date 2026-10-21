import { afterEach, describe, expect, it, vi } from 'vitest'

import { HttpCrmClient } from './http-crm-client'

const UPLOAD_ID = 'a'.repeat(32)
const CHUNK = 3 * 1024 * 1024

function uploadDto() {
  return {
    proposal: {
      id: 1,
      title: '大方案',
      proposal_type: 'other',
      status: 'draft',
      customer_id: null,
      customer_name: null,
      owner_id: 'u1',
      owner_name: '测试',
      current_version_no: 1,
      version_count: 1,
      created_by: 'u1',
      created_at: '2026-10-21T00:00:00Z',
      updated_at: '2026-10-21T00:00:00Z',
    },
    version: {
      id: 1,
      version_no: 1,
      original_filename: 'big.html',
      content_type: 'text/html',
      file_size: 5 * 1024 * 1024,
      change_note: '初始版本',
      created_by: 'u1',
      created_by_name: '测试',
      created_at: '2026-10-21T00:00:00Z',
    },
    warnings: [],
  }
}

describe('HttpCrmClient · 方案分段上传', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('>4MB 走 init → 逐段 → finalize', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith('/proposals/uploads/init')) {
        return new Response(
          JSON.stringify({
            upload_id: UPLOAD_ID,
            chunk_size: CHUNK,
            total_chunks: 2,
            expires_at: '2026-10-21T01:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url.includes('/chunks/')) {
        return new Response(JSON.stringify({ received: 0, size: CHUNK }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.endsWith('/finalize')) {
        return new Response(JSON.stringify(uploadDto()), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const file = new File([new Uint8Array(5 * 1024 * 1024)], 'big.html', {
      type: 'text/html',
    })
    const result = await new HttpCrmClient().createProposal({
      file,
      title: '大方案',
      proposalType: 'other',
    })

    expect(result.proposal.id).toBe('1')
    expect(result.version.versionNo).toBe(1)
    expect(calls.filter((c) => c.includes('/chunks/'))).toHaveLength(2)
    expect(calls.at(-1)).toContain(`/proposals/uploads/${UPLOAD_ID}/finalize`)
  })

  it('≤4MB 保持原一次性 multipart（不调用分段端点）', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      expect(init?.body).toBeInstanceOf(FormData)
      return new Response(JSON.stringify(uploadDto()), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const file = new File(['<html></html>'], 'small.html', { type: 'text/html' })
    await new HttpCrmClient().createProposal({ file })

    expect(calls).toEqual(['POST /api/backend/v1/crm/proposals'])
    expect(calls.some((c) => c.includes('/uploads/init'))).toBe(false)
  })

  it('分段 5xx 会重试，最终成功', async () => {
    let chunkAttempts = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/proposals/uploads/init')) {
        return new Response(
          JSON.stringify({
            upload_id: UPLOAD_ID,
            chunk_size: CHUNK,
            total_chunks: 1,
            expires_at: '2026-10-21T01:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      if (url.includes('/chunks/')) {
        chunkAttempts += 1
        if (chunkAttempts === 1) {
          return new Response('fail', { status: 503 })
        }
        return new Response(JSON.stringify({ received: 0, size: CHUNK }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(uploadDto()), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const file = new File([new Uint8Array(5 * 1024 * 1024)], 'big.html', {
      type: 'text/html',
    })
    await new HttpCrmClient().createProposal({ file })
    expect(chunkAttempts).toBe(2)
  })
})
