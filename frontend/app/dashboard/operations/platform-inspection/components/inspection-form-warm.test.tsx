import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { notify, stableNotifications } from '@/test-utils/stable-mocks'

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

const apiMocks = vi.hoisted(() => ({
  fetchInspectionTemplate: vi.fn().mockResolvedValue({
    health_fields: [],
    service_performance_fields: [],
    shipping_performance_fields: [],
    compliance_fields: [],
  }),
  fetchReport: vi.fn().mockResolvedValue(null),
  saveReport: vi.fn().mockResolvedValue({ id: 12 }),
  submitReport: vi.fn().mockResolvedValue({ id: 12 }),
  uploadScreenshot: vi.fn(),
  deleteScreenshot: vi.fn(),
}))

vi.mock('@/lib/inspection-api', () => apiMocks)

vi.mock('@/components/ui/image-preview-dialog', () => ({
  PortraitScreenshotDialog: () => null,
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <div role="dialog" {...props}>
      {children}
    </div>
  ),
  DialogHeader: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  ),
  DialogTitle: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <h2 {...props}>{children}</h2>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

import InspectionForm from './inspection-form'

beforeEach(() => {
  apiMocks.fetchInspectionTemplate.mockResolvedValue({
    health_fields: [],
    service_performance_fields: [],
    shipping_performance_fields: [],
    compliance_fields: [],
  })
  apiMocks.fetchReport.mockResolvedValue(null)
  apiMocks.saveReport.mockResolvedValue({ id: 12 })
  apiMocks.submitReport.mockResolvedValue({ id: 12 })
  apiMocks.uploadScreenshot.mockReset()
  apiMocks.deleteScreenshot.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:inspection-shot'),
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderForm() {
  render(
    <InspectionForm
      periodId={7}
      projectId={1}
      open
      onClose={vi.fn()}
      onBack={vi.fn()}
      onSubmitSuccess={vi.fn()}
    />
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('Inspection Form Warm Ledger contract', () => {
  it('keeps the dialog and draft-save behavior inside a Warm surface', async () => {
    renderForm()

    await screen.findByRole('dialog')
    const dialog = await screen.findByTestId('inspection-form-dialog')
    expect(dialog).toHaveAttribute('data-warm-inspection-form', 'true')
    expect(screen.getByTestId('inspection-dialog-title')).toHaveAttribute(
      'data-warm-dialog-title',
      'true'
    )

    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }))
    await waitFor(() => expect(apiMocks.saveReport).toHaveBeenCalledTimes(1))
    expect(apiMocks.saveReport).toHaveBeenCalledWith(
      7,
      1,
      expect.objectContaining({
        health_data: expect.any(Object),
        compliance_data: expect.any(Object),
        screenshot_ids: [],
      })
    )
  })

  it('validates screenshot type and size before upload', async () => {
    renderForm()
    await screen.findByTestId('inspection-form-dialog')
    const input = screen.getByTestId('inspection-upload-input')

    fireEvent.change(input, {
      target: {
        files: [new File(['pdf'], 'not-image.pdf', { type: 'application/pdf' })],
      },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent('仅支持图片文件')

    const oversized = new File(['image'], 'oversized.png', { type: 'image/png' })
    Object.defineProperty(oversized, 'size', { value: 10 * 1024 * 1024 + 1 })
    fireEvent.change(input, { target: { files: [oversized] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('文件大小不能超过 10MB')

    expect(apiMocks.saveReport).not.toHaveBeenCalled()
    expect(apiMocks.uploadScreenshot).not.toHaveBeenCalled()
  })

  it('uploads via drag/drop, exposes loading, saves screenshot ids, and deletes screenshots', async () => {
    const upload = deferred<{
      id: number
      url: string
      filename: string
      caption: string | null
    }>()
    apiMocks.uploadScreenshot.mockReturnValueOnce(upload.promise)
    renderForm()
    await screen.findByTestId('inspection-form-dialog')

    fireEvent.drop(screen.getByTestId('inspection-upload-dropzone'), {
      dataTransfer: {
        files: [new File(['image'], 'shot.png', { type: 'image/png' })],
      },
    })

    expect(await screen.findByText('上传中...')).toBeInTheDocument()
    await waitFor(() => expect(apiMocks.saveReport).toHaveBeenCalledTimes(1))
    expect(apiMocks.uploadScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'shot.png' }),
      12
    )

    upload.resolve({
      id: 77,
      url: 'https://example.test/shot.png',
      filename: 'shot.png',
      caption: null,
    })
    expect(await screen.findByAltText('shot.png')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '提交报告' }))
    await waitFor(() => expect(apiMocks.submitReport).toHaveBeenCalledWith(7, 1))
    expect(apiMocks.saveReport).toHaveBeenLastCalledWith(
      7,
      1,
      expect.objectContaining({ screenshot_ids: [77] })
    )

    fireEvent.click(screen.getByRole('button', { name: '删除截图 shot.png' }))
    await waitFor(() => expect(apiMocks.deleteScreenshot).toHaveBeenCalledWith(77))
    await waitFor(() => expect(screen.queryByAltText('shot.png')).not.toBeInTheDocument())
  })

  it('shows a local upload error when the upload request fails', async () => {
    apiMocks.uploadScreenshot.mockRejectedValueOnce(new Error('network failed'))
    renderForm()
    await screen.findByTestId('inspection-form-dialog')

    fireEvent.drop(screen.getByTestId('inspection-upload-dropzone'), {
      dataTransfer: {
        files: [new File(['image'], 'failed.png', { type: 'image/png' })],
      },
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('上传失败，请重试')
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: '上传失败' }))
    expect(screen.queryByAltText('failed.png')).not.toBeInTheDocument()
  })

  it('keeps page-local title and close-button typography out of shared defaults', () => {
    const css = readFileSync(
      join(__dirname, '..', 'platform-inspection-warm.module.css'),
      'utf8'
    )

    expect(css).toContain('.dialogTitle[class]')
    expect(css).toContain('.drawerTitle[class]')
    expect(css).toContain('.dialog[class] > button:last-child')
    expect(css).toContain('.drawer[class] > button:last-child')
    expect(css).toContain('font-family: var(--warm-ledger-font-sans)')
    expect(css).toContain('border-radius: var(--warm-ledger-radius-inner)')
  })
})
