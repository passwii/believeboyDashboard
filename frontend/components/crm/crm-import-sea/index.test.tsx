import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CrmImportSea } from './index'

const importMock = vi.fn()
vi.mock('@/lib/crm/api/crm-client-provider', () => ({
  useCrmClient: () => ({ importCustomersToSea: importMock }),
}))
vi.mock('@/components/notifications', () => ({ useNotifications: () => ({ notify: vi.fn() }) }))
vi.mock('./template', () => ({ downloadImportTemplate: vi.fn(), downloadFailureDetail: vi.fn() }))

describe('CrmImportSea', () => {
  it('粘贴 TSV → 预览 → 导入成功显示计数', async () => {
    importMock.mockResolvedValue({ created: 2, skippedDupes: 0, failed: [] })
    render(<CrmImportSea open onOpenChange={() => {}} onImported={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: '粘贴' }))
    fireEvent.change(screen.getByPlaceholderText(/从 Excel 复制/), {
      target: { value: '客户名\t等级\n甲公司\tA\n乙公司\tB' },
    })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(await screen.findByText(/共 2 行/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /确认导入/ }))
    await waitFor(() => expect(importMock).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/成功 2/)).toBeTruthy()
  })

  it('缺客户名列 → 提示无法解析', async () => {
    render(<CrmImportSea open onOpenChange={() => {}} onImported={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: '粘贴' }))
    fireEvent.change(screen.getByPlaceholderText(/从 Excel 复制/), { target: { value: '简称\nx' } })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(await screen.findByText(/缺少「客户名」列/)).toBeTruthy()
  })
})
