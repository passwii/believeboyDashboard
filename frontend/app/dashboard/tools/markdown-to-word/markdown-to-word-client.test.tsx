import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { notify, stableNotifications } from '@/test-utils/stable-mocks'

import MarkdownToWordClient from './markdown-to-word-client'

const markdownMocks = vi.hoisted(() => ({
  createPdfFilename: vi.fn(() => 'brief-20261104.pdf'),
  createWordFilename: vi.fn(() => 'brief-20261104.docx'),
  downloadMarkdownAsPdf: vi.fn(() => Promise.resolve()),
  downloadMarkdownAsWord: vi.fn(() => Promise.resolve()),
  readMarkdownFile: vi.fn(),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

vi.mock('./lib/markdown-to-word', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/markdown-to-word')>()
  return {
    ...actual,
    ...markdownMocks,
  }
})

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

beforeEach(() => {
  vi.clearAllMocks()
  markdownMocks.readMarkdownFile.mockResolvedValue('# 上传的标题\n\n本地内容')
  markdownMocks.createWordFilename.mockReturnValue('brief-20261104.docx')
  markdownMocks.createPdfFilename.mockReturnValue('brief-20261104.pdf')
  markdownMocks.downloadMarkdownAsWord.mockResolvedValue(undefined)
  markdownMocks.downloadMarkdownAsPdf.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe('MarkdownToWordClient', () => {
  it('renders the shared Warm split workspace with editor and preview panels', () => {
    const { container } = render(<MarkdownToWordClient />)

    const frame = container.querySelector('[data-tools-page-frame="true"]')
    expect(frame).toHaveAttribute('data-layout', 'split')
    expect(screen.getByRole('region', { name: 'Markdown 编辑区' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '实时预览' })).toBeInTheDocument()
    expect(screen.getByLabelText('Markdown 内容')).toBeInTheDocument()
  })

  it('keeps export disabled until content exists and shows the empty preview state', () => {
    render(<MarkdownToWordClient />)

    expect(screen.getByText('暂无 Markdown 内容')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /下载 PDF/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /下载 Word/ })).toBeDisabled()
  })

  it('reads Markdown locally, shows source metadata, and never calls the server', async () => {
    const markdown = '# 上传的标题\n\n本地内容'
    markdownMocks.readMarkdownFile.mockResolvedValue(markdown)
    const user = userEvent.setup()
    render(<MarkdownToWordClient />)

    const file = new File([markdown.padEnd(1024, ' ')], 'brief.md', {
      type: 'text/markdown',
    })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)

    await waitFor(() => expect(markdownMocks.readMarkdownFile).toHaveBeenCalledWith(file))
    expect(screen.getByLabelText('Markdown 内容')).toHaveValue('# 上传的标题\n\n本地内容')
    expect(screen.getAllByText('brief.md').length).toBeGreaterThan(0)
    expect(screen.getByText('1.0 KB')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: '上传的标题' })).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renders typed Markdown and keeps the existing Word/PDF filename contract', async () => {
    const user = userEvent.setup()
    render(<MarkdownToWordClient />)

    const textarea = screen.getByLabelText('Markdown 内容')
    await user.type(textarea, '# 标题')
    expect(await screen.findByRole('heading', { name: '标题' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /下载 Word/ }))
    await waitFor(() =>
      expect(markdownMocks.downloadMarkdownAsWord).toHaveBeenCalledWith(
        '# 标题',
        'brief-20261104.docx'
      )
    )
    expect(markdownMocks.createWordFilename).toHaveBeenCalledWith(undefined)

    await user.click(screen.getByRole('button', { name: /下载 PDF/ }))
    await waitFor(() =>
      expect(markdownMocks.downloadMarkdownAsPdf).toHaveBeenCalledWith(
        '# 标题',
        'brief-20261104.pdf'
      )
    )
    expect(markdownMocks.createPdfFilename).toHaveBeenCalledWith(undefined)
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', title: 'Word 文件已生成' })
    )
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', title: 'PDF 文件已生成' })
    )
  })

  it('clears the editor, source filename, and preview', async () => {
    markdownMocks.readMarkdownFile.mockResolvedValue('# 待清空')
    const user = userEvent.setup()
    render(<MarkdownToWordClient />)

    const file = new File(['# 待清空'], 'draft.md', { type: 'text/markdown' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, file)
    await screen.findByRole('heading', { name: '待清空' })

    await user.click(screen.getByRole('button', { name: '清空' }))

    expect(screen.getByLabelText('Markdown 内容')).toHaveValue('')
    expect(screen.queryByText('draft.md')).not.toBeInTheDocument()
    expect(screen.getByText('暂无 Markdown 内容')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /下载 Word/ })).toBeDisabled()
  })
})

describe('Markdown to Word V4 contract', () => {
  it('uses Warm tokens with a phone keyboard and output-scroll breakpoint', () => {
    const css = readFileSync(join(__dirname, 'markdown-to-word.module.css'), 'utf8')
    const source = readFileSync(join(__dirname, 'markdown-to-word-client.tsx'), 'utf8')

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-radius-control)')
    expect(css).toContain('var(--warm-ledger-focus-color)')
    expect(css).toContain('@media (max-width: 640px)')
    expect(css).toContain('font-size: 16px')
    expect(css).toContain('max-height: min(56dvh, 520px)')
    expect(css).not.toContain('--term-')
    expect(source).not.toContain('term-')
    expect(source).not.toContain('rounded-none')
    expect(source).not.toMatch(/\b(?:sm|md|lg|xl|2xl):/)
  })
})
