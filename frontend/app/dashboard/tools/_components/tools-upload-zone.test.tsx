import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { ToolsUploadZone } from './index'

describe('ToolsUploadZone', () => {
  it('keeps the shared UploadZone prop and interaction contract', async () => {
    const user = userEvent.setup()
    const onUpload = vi.fn()
    const file = new File(['# title'], 'brief.md', { type: 'text/markdown' })

    const { container } = render(
      <ToolsUploadZone
        accept=".md,text/markdown"
        maxSize={5}
        uploadingText="正在读取 Markdown..."
        onUpload={onUpload}
        className="caller-upload"
      />
    )

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).toHaveAttribute('accept', '.md,text/markdown')
    expect(screen.getByRole('button', { name: '上传文件' })).toBeInTheDocument()
    expect(screen.getByText('点击此处激活粘贴上传，或拖拽文件到这里')).toBeInTheDocument()
    expect(container.firstElementChild).toHaveAttribute('data-tools-upload-zone', 'true')
    expect(container.firstElementChild).toHaveClass('caller-upload')

    await user.upload(input, file)
    await waitFor(() => expect(onUpload).toHaveBeenCalledWith(file))
  })

  it('preserves the shared disabled state', () => {
    render(<ToolsUploadZone disabled onUpload={vi.fn()} />)

    expect(screen.getByRole('button', { name: '上传文件' })).toBeDisabled()
  })

  it('uses Warm surface overrides without changing shared UploadZone defaults', () => {
    const css = readFileSync(join(__dirname, 'tools-upload-zone.module.css'), 'utf8')

    expect(css).toContain('var(--warm-ledger-color-panel)')
    expect(css).toContain('var(--warm-ledger-color-accent-soft)')
    expect(css).toContain('var(--warm-ledger-radius-control)')
    expect(css).toContain('@media (max-width: 640px)')
    expect(css).toContain('flex-direction: column')
    expect(css).toContain("[class*='border-term-neg']")
    expect(css).toContain('> div:first-child > div > div')
    expect(css).not.toContain('--term-')
  })
})
