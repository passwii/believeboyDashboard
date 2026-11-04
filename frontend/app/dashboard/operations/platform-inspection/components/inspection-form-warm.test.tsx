import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { stableNotifications } from '@/test-utils/stable-mocks'

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
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

import InspectionForm from './inspection-form'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Inspection Form Warm Ledger contract', () => {
  it('keeps the dialog and draft-save behavior inside a Warm surface', async () => {
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

    await screen.findByRole('dialog')
    const dialog = await screen.findByTestId('inspection-form-dialog')
    expect(dialog).toHaveAttribute('data-warm-inspection-form', 'true')

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
})
