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
