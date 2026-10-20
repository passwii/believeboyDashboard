import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ProposalCreateForm, ProposalVersionForm } from './upload-form'

function htmlFile(name = 'plan.html', content = '<html></html>') {
  return new File([content], name, { type: 'text/html' })
}

function selectFile(testId: string, file: File) {
  fireEvent.change(screen.getByTestId(testId), { target: { files: [file] } })
}

describe('ProposalCreateForm', () => {
  it('未选文件时提交按钮禁用', () => {
    render(<ProposalCreateForm customers={[]} onSubmit={vi.fn()} />)
    expect(screen.getByRole('button', { name: '上传并创建' })).toBeDisabled()
  })

  it('拒绝非 HTML 文件并提示', () => {
    render(<ProposalCreateForm customers={[]} onSubmit={vi.fn()} />)
    selectFile('proposal-file-input', new File(['x'], 'a.md', { type: 'text/markdown' }))
    expect(screen.getByText('仅支持单个 HTML 文件（.html / .htm）')).toBeTruthy()
    expect(screen.getByRole('button', { name: '上传并创建' })).toBeDisabled()
  })

  it('提交时带上文件 + 标题 + 类型 + 关联客户', async () => {
    const onSubmit = vi.fn()
    render(
      <ProposalCreateForm
        customers={[{ id: '7', name: '客户A' }]}
        onSubmit={onSubmit}
      />
    )
    const file = htmlFile()
    selectFile('proposal-file-input', file)
    fireEvent.change(screen.getByPlaceholderText('例如：亚马逊代运营入驻方案'), {
      target: { value: '入驻方案' },
    })
    fireEvent.change(screen.getByLabelText('方案类型'), { target: { value: 'quotation' } })
    fireEvent.change(screen.getByLabelText('关联客户（可选）'), { target: { value: '7' } })

    fireEvent.click(screen.getByRole('button', { name: '上传并创建' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith({
      file,
      title: '入驻方案',
      proposalType: 'quotation',
      customerId: '7',
    })
  })

  /**
   * BLF-1407：新增「调研方案」类型（`research`）。类型下拉是枚举驱动的
   * （map `PROPOSAL_TYPE_ORDER`），这里钉住「下拉里能选到 research 且
   * 提交时原样带上」—— 防止有人只改 union 不改 ORDER/LABELS。
   */
  it('类型下拉可选「调研方案」并原样提交', async () => {
    const onSubmit = vi.fn()
    render(<ProposalCreateForm customers={[]} onSubmit={onSubmit} />)

    const typeSelect = screen.getByLabelText('方案类型') as HTMLSelectElement
    const options = Array.from(typeSelect.options).map((o) => ({
      value: o.value,
      label: o.textContent,
    }))
    expect(options).toContainEqual({ value: 'research', label: '调研方案' })

    selectFile('proposal-file-input', htmlFile())
    fireEvent.change(typeSelect, { target: { value: 'research' } })
    fireEvent.click(screen.getByRole('button', { name: '上传并创建' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].proposalType).toBe('research')
  })

  it('标题留空则传 undefined（后端回退文件名）', async () => {
    const onSubmit = vi.fn()
    render(<ProposalCreateForm customers={[]} onSubmit={onSubmit} />)
    selectFile('proposal-file-input', htmlFile())
    fireEvent.click(screen.getByRole('button', { name: '上传并创建' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0][0].title).toBeUndefined()
    expect(onSubmit.mock.calls[0][0].customerId).toBeNull()
  })
})

describe('ProposalVersionForm', () => {
  it('提交文件 + 变更说明', async () => {
    const onSubmit = vi.fn()
    render(<ProposalVersionForm onSubmit={onSubmit} />)
    const file = htmlFile('plan-v2.html')
    selectFile('proposal-version-file', file)
    fireEvent.change(screen.getByPlaceholderText('例如：补充服务范围与报价区间'), {
      target: { value: '补充报价' },
    })
    fireEvent.click(screen.getByRole('button', { name: '上传新版本' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith({ file, changeNote: '补充报价' })
  })

  it('空文件被拒', () => {
    render(<ProposalVersionForm onSubmit={vi.fn()} />)
    selectFile('proposal-version-file', htmlFile('empty.html', ''))
    expect(screen.getByText('文件为空')).toBeTruthy()
    expect(screen.getByRole('button', { name: '上传新版本' })).toBeDisabled()
  })
})

/**
 * BLF-1404：本地预校验上限与后端 `crm_proposal_max_bytes`（20MB）同口径。
 * 之前上限硬编码在组件里（5 → 20 各改一处），现抽到
 * `lib/crm/constants/proposal.ts` —— 这里钉住“常量与提示文案仍一致”。
 *
 * ⚠️ BLF-1404 复核：预校验上限是**模式相关**的 ——
 * - mock 模式（默认，本地 / 单测）→ 文件只进 localStorage，不过网关 → 20MB；
 * - http 模式（生产）→ 经 Next 代理 → Vercel 网关 4.5MB 硬卡 → 4MB。
 * 本文件跑在 mock 模式（`NEXT_PUBLIC_CRM_API_MODE` 未设置）→ 断言 20MB。
 */
describe('上传大小本地预校验（mock 模式 = 20MB 上限）', () => {
  it('超过上限的文件被拦下并提示 20MB', () => {
    render(<ProposalCreateForm customers={[]} onSubmit={vi.fn()} />)
    // 用 21MB 的假 File（只声明 size，不真造字节）。
    const big = new File(['x'], 'big.html', { type: 'text/html' })
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 })
    selectFile('proposal-file-input', big)
    expect(screen.getByText('文件超过 20 MB 上限')).toBeTruthy()
    expect(screen.getByRole('button', { name: '上传并创建' })).toBeDisabled()
  })

  it('小于上限的文件放行', () => {
    render(<ProposalCreateForm customers={[]} onSubmit={vi.fn()} />)
    const ok = new File(['x'], 'ok.html', { type: 'text/html' })
    Object.defineProperty(ok, 'size', { value: 19 * 1024 * 1024 })
    selectFile('proposal-file-input', ok)
    expect(screen.queryByText(/文件超过/)).toBeNull()
    expect(screen.getByRole('button', { name: '上传并创建' })).not.toBeDisabled()
  })
})
