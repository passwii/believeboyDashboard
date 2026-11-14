import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { notify, stableNotifications } from '@/test-utils/stable-mocks'

import PageRenderClient from './page-render-client'

const headerRefresh = vi.hoisted(() => ({
  handler: null as null | (() => void | Promise<void>),
  loading: undefined as boolean | undefined,
}))
const confirmMock = vi.hoisted(() => vi.fn())

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('@/hooks/use-confirm', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: (
    handler: () => void | Promise<void>,
    options?: { loading?: boolean }
  ) => {
    headerRefresh.handler = handler
    headerRefresh.loading = options?.loading
  },
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

type UploadedPage = {
  id: string
  title: string
  source_format: 'markdown' | 'html'
  public_url: string
  original_filename: string
  file_size: number
  created_at: string
}

const HISTORY_ROW: UploadedPage = {
  id: 'page-1',
  title: '季度公告',
  source_format: 'markdown',
  public_url: 'https://cdn.example.com/page-1.md',
  original_filename: 'quarterly.md',
  file_size: 2048,
  created_at: '2026-11-04T08:00:00.000Z',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function emptyHistory() {
  return jsonResponse({ items: [], total: 0 })
}

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  headerRefresh.handler = null
  headerRefresh.loading = undefined
  confirmMock.mockResolvedValue(true)
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    if (String(input).includes('/page-render/history')) return Promise.resolve(emptyHistory())
    throw new Error(`unexpected fetch: ${String(input)}`)
  })
})

afterEach(() => {
  cleanup()
})

describe('PageRenderClient', () => {
  it('loads owner-scoped history inside the shared Warm stack', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [HISTORY_ROW], total: 1 }))
    const { container } = render(<PageRenderClient />)

    const frame = container.querySelector('[data-tools-page-frame="true"]')
    expect(frame).toHaveAttribute('data-layout', 'stack')
    expect(screen.getByRole('region', { name: '上传 Markdown 或 HTML' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '我的历史' })).toBeInTheDocument()
    expect(await screen.findByText('季度公告')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/backend/api/v1/page-render/history?limit=50', {
      cache: 'no-store',
    })
    expect(headerRefresh.handler).toEqual(expect.any(Function))
  })

  it('shows a local Markdown preview before the immediate upload resolves', async () => {
    const upload = deferredResponse()
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/page-render/history')) return Promise.resolve(emptyHistory())
      if (url.endsWith('/page-render/upload')) return upload.promise
      throw new Error(`unexpected fetch: ${url}`)
    })
    const user = userEvent.setup()
    render(<PageRenderClient />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await user.type(screen.getByLabelText('页面标题（可选，留空使用文件名）'), '发布说明')
    const file = new File(['# 本地预览'], 'notice.md', { type: 'text/markdown' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    expect(await screen.findByRole('heading', { name: '本地预览' })).toBeInTheDocument()
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/backend/api/v1/page-render/upload',
        expect.objectContaining({ method: 'POST' })
      )
    )

    const uploadCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/page-render/upload')
    )
    const body = uploadCall?.[1]?.body as FormData
    expect(body.get('title')).toBe('发布说明')
    expect((body.get('file') as File).name).toBe('notice.md')

    upload.resolve(
      jsonResponse({
        ...HISTORY_ROW,
        id: 'page-2',
        title: '发布说明',
        original_filename: 'notice.md',
      })
    )
    expect(await screen.findByRole('heading', { name: '公开链接已生成' })).toBeInTheDocument()
  })

  it('keeps HTML previews sandboxed and on the white paper surface', async () => {
    const upload = deferredResponse()
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/page-render/history')) return Promise.resolve(emptyHistory())
      if (url.endsWith('/page-render/upload')) return upload.promise
      throw new Error(`unexpected fetch: ${url}`)
    })
    const user = userEvent.setup()
    render(<PageRenderClient />)

    const html = '<!doctype html><html><body><h1>HTML 页面</h1></body></html>'
    const file = new File([html], 'notice.html', { type: 'text/html' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    const iframe = await screen.findByTitle('HTML 预览')
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
    expect(iframe).toHaveAttribute('data-preview-surface', 'paper')
    expect(iframe.getAttribute('srcdoc')).toBe(html)

    upload.resolve(
      jsonResponse({
        ...HISTORY_ROW,
        id: 'page-3',
        title: 'notice',
        source_format: 'html',
        original_filename: 'notice.html',
      })
    )
    await screen.findByRole('heading', { name: '公开链接已生成' })
  })

  it('keeps public-link copy and owner-scoped delete contracts', async () => {
    let historyCalls = 0
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/page-render/history')) {
        historyCalls += 1
        return Promise.resolve(
          historyCalls === 1
            ? jsonResponse({ items: [HISTORY_ROW], total: 1 })
            : emptyHistory()
        )
      }
      if (url.endsWith('/page-render/page-1') && init?.method === 'DELETE') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const user = userEvent.setup()
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockResolvedValue(undefined)
    render(<PageRenderClient />)

    expect(await screen.findByRole('link', { name: '打开页面：季度公告' })).toHaveAttribute(
      'href',
      '/p/page-1'
    )

    await user.click(screen.getByRole('button', { name: '复制链接：季度公告' }))
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/p/page-1`)
    )

    await user.click(screen.getByRole('button', { name: '删除页面：季度公告' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/backend/api/v1/page-render/page-1', {
        method: 'DELETE',
      })
    )
    expect(confirmMock).toHaveBeenCalledWith({
      title: '确定删除这个页面？删除后公开链接将立即失效。',
      variant: 'destructive',
    })
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', title: '已删除' })
    )
    expect(await screen.findByText('暂无记录，上传一个文件试试')).toBeInTheDocument()
  })
})

describe('Page Render V4 contract', () => {
  it('uses Warm surfaces, a phone reflow, and the explicit white paper exception', () => {
    const css = readFileSync(join(__dirname, 'page-render.module.css'), 'utf8')
    const source = readFileSync(join(__dirname, 'page-render-client.tsx'), 'utf8')

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-radius-control)')
    expect(css).toContain('background: #fff')
    expect(css).toContain('@media (max-width: 640px)')
    expect(css).toContain('font-size: 16px')
    expect(css).toContain('max-height: min(56dvh, 520px)')
    expect(css).not.toContain('--term-')
    expect(source).not.toContain('term-')
    expect(source).not.toContain('rounded-none')
    expect(source).not.toMatch(/\b(?:sm|md|lg|xl|2xl):/)
  })
})
