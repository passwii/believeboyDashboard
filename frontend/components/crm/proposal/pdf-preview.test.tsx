import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ProposalPdfPreview } from './pdf-preview'

const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:mock-pdf')
const revokeObjectURL = vi.fn<(url: string) => void>()

beforeEach(() => {
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  // jsdom 没有 blob URL API，预览组件依赖它
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ProposalPdfPreview', () => {
  it('拉到字节后渲染内嵌 iframe，并把 MIME 强制成 application/pdf', async () => {
    const load = vi.fn().mockResolvedValue(new Blob(['%PDF'], { type: 'text/html' }))
    render(<ProposalPdfPreview title="报价方案" load={load} />)

    expect(screen.getByTestId('proposal-pdf-loading')).toBeTruthy()
    const frame = await screen.findByTestId('proposal-pdf-preview')
    expect(frame.getAttribute('src')).toBe('blob:mock-pdf')
    expect(frame.getAttribute('title')).toBe('报价方案 · PDF')
    expect(createObjectURL.mock.calls[0][0].type).toBe('application/pdf')
  })

  it('已有 application/pdf 的 blob 不再包一层', async () => {
    const blob = new Blob(['%PDF'], { type: 'application/pdf' })
    render(<ProposalPdfPreview title="方案" load={vi.fn().mockResolvedValue(blob)} />)
    await screen.findByTestId('proposal-pdf-preview')
    expect(createObjectURL.mock.calls[0][0]).toBe(blob)
  })

  it('加载失败时展示错误与重试，重试会重新拉取', async () => {
    const onError = vi.fn()
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('网络错误'))
      .mockResolvedValueOnce(new Blob(['%PDF'], { type: 'application/pdf' }))

    render(<ProposalPdfPreview title="方案" load={load} onError={onError} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('网络错误')
    expect(onError).toHaveBeenCalledWith('网络错误')

    fireEvent.click(screen.getByRole('button', { name: /重新加载/ }))
    await screen.findByTestId('proposal-pdf-preview')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('卸载时释放 blob URL', async () => {
    const { unmount } = render(
      <ProposalPdfPreview
        title="方案"
        load={vi.fn().mockResolvedValue(new Blob(['%PDF'], { type: 'application/pdf' }))}
      />
    )
    await screen.findByTestId('proposal-pdf-preview')
    unmount()
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-pdf'))
  })
})
