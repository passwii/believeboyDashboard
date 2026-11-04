import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { notify, stableNotifications } from '@/test-utils/stable-mocks'

import ProductLabelClient from './product-label-client'

// ── mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

// jsdom 没有 createObjectURL/revokeObjectURL，下载路径会调用它们。
// anchor.click() 在 jsdom 里会尝试真的导航，这里打成空实现（同
// return-analysis-client.test.tsx 的做法）。
beforeEach(() => {
  vi.clearAllMocks()
  URL.createObjectURL = vi.fn(() => 'blob:mock')
  URL.revokeObjectURL = vi.fn()
  HTMLAnchorElement.prototype.click = vi.fn()
})

afterEach(() => {
  cleanup()
})

// ── helpers ──────────────────────────────────────────────────────────────────

function makePdf(name = 'label.pdf') {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], name, {
    type: 'application/pdf',
  })
}

function pdfResponse() {
  return new Response(new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])]), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="label-labeled.pdf"',
    },
  })
}

/** 通过隐藏的 file input 上传，绕开点击/拖拽的差异。 */
async function uploadLabel(user: ReturnType<typeof userEvent.setup>, file = makePdf()) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await user.upload(input, file)
  // 文件名同时出现在 UploadZone 预览与文件信息表里，这里只断言后者。
  await waitFor(() =>
    expect(screen.getByTestId('selected-file-name')).toHaveTextContent(file.name)
  )
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('ProductLabelClient', () => {
  it('初始状态：未选文件、生成按钮禁用，且默认勾选 Made In China', () => {
    const { container } = render(<ProductLabelClient />)

    expect(container.querySelector('[data-tools-page-frame="true"]')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-tools-panel="true"]')).toHaveLength(2)
    expect(container.querySelector('[data-tools-upload-zone="true"]')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '产品标签制作' })).toBeInTheDocument()
    expect(screen.getByText('未选择')).toBeInTheDocument()
    expect(screen.getByText('0/3 行 · 0/200 字')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /生成并下载/ })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Made In China' })).toBeChecked()
    expect(document.querySelector('input[type="file"]')).toHaveAttribute(
      'accept',
      '.pdf,application/pdf'
    )
  })

  it('上传标签后展示文件名，生成按钮可用', async () => {
    const user = userEvent.setup()
    render(<ProductLabelClient />)

    await uploadLabel(user)

    expect(screen.getByRole('button', { name: /生成并下载/ })).toBeEnabled()
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', title: '标签已就绪' })
    )
  })

  it('生成成功时以 FormData 提交并触发下载', async () => {
    fetchMock.mockResolvedValue(pdfResponse())
    const user = userEvent.setup()
    render(<ProductLabelClient />)

    await uploadLabel(user)
    await user.type(screen.getByLabelText('文案'), 'Designed in California')
    await user.click(screen.getByRole('button', { name: /生成并下载/ }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/backend/api/v1/product-label/generate')
    expect(init.method).toBe('POST')
    const body = init.body as FormData
    expect(body.get('text')).toBe('Designed in California')
    expect(body.get('made_in_china')).toBe('true')
    expect((body.get('file') as File).name).toBe('label.pdf')

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', title: '标签已生成' })
      )
    )
    expect(URL.createObjectURL).toHaveBeenCalled()
  })

  it('后端返回 400 时把中文 detail 原样提示，不触发下载', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: '该 PDF 提取不到任何文字（可能是纯图片标签）。' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    )
    const user = userEvent.setup()
    render(<ProductLabelClient />)

    await uploadLabel(user)
    await user.type(screen.getByLabelText('文案'), 'Hello')
    await user.click(screen.getByRole('button', { name: /生成并下载/ }))

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          title: '生成失败',
          message: '该 PDF 提取不到任何文字（可能是纯图片标签）。',
        })
      )
    )
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('未选文件时点生成会被前端拦下（不发请求）', async () => {
    const user = userEvent.setup()
    render(<ProductLabelClient />)

    // 按钮此时是禁用的，直接断言禁用 + 没有请求
    const button = screen.getByRole('button', { name: /生成并下载/ })
    expect(button).toBeDisabled()
    await user.click(button).catch(() => undefined)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('取消勾选 Made In China 且不填文案时，生成按钮被禁用', async () => {
    const user = userEvent.setup()
    render(<ProductLabelClient />)

    await uploadLabel(user)
    expect(screen.getByRole('button', { name: /生成并下载/ })).toBeEnabled()

    await user.click(screen.getByRole('checkbox', { name: 'Made In China' }))

    // 既没文案也没勾选 → 无可追加内容，按钮禁用（不发请求）
    expect(screen.getByRole('checkbox', { name: 'Made In China' })).not.toBeChecked()
    expect(screen.getByRole('button', { name: /生成并下载/ })).toBeDisabled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('超过 50MB 的文件在客户端拦下，不进入生成流程', async () => {
    const user = userEvent.setup()
    render(<ProductLabelClient />)

    const oversized = makePdf('oversized.pdf')
    Object.defineProperty(oversized, 'size', { value: 51 * 1024 * 1024 })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await user.upload(input, oversized)

    expect(await screen.findByText('ERR · 文件大小不能超过 50MB')).toBeInTheDocument()
    expect(screen.getByTestId('selected-file-name')).toHaveTextContent('未选择')
    expect(screen.getByRole('button', { name: /生成并下载/ })).toBeDisabled()
  })

  it('生成后可重新下载上一次的结果', async () => {
    fetchMock.mockResolvedValue(pdfResponse())
    const user = userEvent.setup()
    render(<ProductLabelClient />)

    await uploadLabel(user)
    await user.click(screen.getByRole('button', { name: /生成并下载/ }))

    const redownload = await screen.findByRole('button', { name: /重新下载/ })
    ;(URL.createObjectURL as ReturnType<typeof vi.fn>).mockClear()
    await user.click(redownload)

    expect(URL.createObjectURL).toHaveBeenCalled()
    // 重新下载不该再打接口
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('重置清空文件、文案与上次结果', async () => {
    fetchMock.mockResolvedValue(pdfResponse())
    const user = userEvent.setup()
    render(<ProductLabelClient />)

    await uploadLabel(user)
    await user.type(screen.getByLabelText('文案'), 'Hello')
    await user.click(screen.getByRole('button', { name: /生成并下载/ }))
    await screen.findByRole('button', { name: /重新下载/ })

    await user.click(screen.getByRole('button', { name: /重置/ }))

    expect(screen.getByText('未选择')).toBeInTheDocument()
    expect(screen.getByLabelText('文案')).toHaveValue('')
    expect(screen.queryByRole('button', { name: /重新下载/ })).not.toBeInTheDocument()
  })
})
