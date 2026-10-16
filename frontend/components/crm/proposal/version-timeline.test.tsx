import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { ProposalVersionTimeline } from './version-timeline'
import type { ProposalVersion } from '@/lib/crm/types'

function v(no: number, note?: string): ProposalVersion {
  return {
    id: `pv-${no}`,
    versionNo: no,
    originalFilename: `plan-v${no}.html`,
    contentType: 'text/html',
    fileSize: 1024 * no,
    changeNote: note,
    createdAt: '2026-10-14T09:00:00.000Z',
  }
}

const VERSIONS = [v(3, '补充报价'), v(2, '调整服务范围'), v(1, '初始版本')]

function setup(overrides?: Partial<React.ComponentProps<typeof ProposalVersionTimeline>>) {
  const onSelect = vi.fn()
  const onDownload = vi.fn()
  render(
    <ProposalVersionTimeline
      versions={VERSIONS}
      currentVersionNo={3}
      selectedVersionNo={3}
      onSelect={onSelect}
      onDownload={onDownload}
      {...overrides}
    />
  )
  return { onSelect, onDownload }
}

describe('ProposalVersionTimeline', () => {
  it('按传入顺序渲染全部版本，并标注当前版本', () => {
    setup()
    const rows = screen.getAllByTestId(/^proposal-version-\d$/)
    expect(rows).toHaveLength(3)
    expect(screen.getAllByText('当前')).toHaveLength(1)
    expect(screen.getByText('补充报价')).toBeTruthy()
  })

  it('点版本行触发预览回调', () => {
    const { onSelect } = setup()
    fireEvent.click(screen.getByTestId('proposal-version-select-2'))
    expect(onSelect).toHaveBeenCalledWith(2)
  })

  it('下载按钮区分「适配版」与「原始版」', () => {
    const { onDownload } = setup()
    fireEvent.click(screen.getByLabelText('下载 v2'))
    expect(onDownload).toHaveBeenCalledWith(2)

    fireEvent.click(screen.getByLabelText('下载 v2 原始版'))
    expect(onDownload).toHaveBeenCalledWith(2, { raw: true })
  })

  it('正在下载的版本按钮禁用', () => {
    setup({ downloadingVersionNo: 2 })
    expect(screen.getByLabelText('下载 v2')).toBeDisabled()
  })

  it('空列表给出空态', () => {
    setup({ versions: [] })
    expect(screen.getByText('暂无版本')).toBeTruthy()
  })
})
