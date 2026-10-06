import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { stableNotifications } from '@/test-utils/stable-mocks'

// BEL-423：快照列表懒加载 —— 下拉关闭时不请求；首次打开才请求；同一作用域
// 重复开关不重复请求；refreshNonce 变化（快照增删后）下次打开重新请求。

vi.mock('@/components/notifications', () => ({
  useNotifications: () => stableNotifications(),
}))

import { SnapshotSelector, type SnapshotSelectorProps } from './snapshot-selector'

const BASE_PROPS: SnapshotSelectorProps = {
  projectId: 1,
  country: 'US',
  selectedSnapshotId: null,
  onSnapshotSelect: vi.fn(),
  onCreateSnapshot: vi.fn(),
  onEditSnapshot: vi.fn(),
}

function emptyListResponse(): Response {
  return new Response(JSON.stringify([]), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('SnapshotSelector 懒加载（BEL-423）', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('下拉关闭时不请求快照列表（mount 不发请求）', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => emptyListResponse())
    render(<SnapshotSelector {...BASE_PROPS} />)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('首次打开才请求；关闭再打开不重复请求', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => emptyListResponse())
    render(<SnapshotSelector {...BASE_PROPS} />)

    await user.click(screen.getByRole('button', { name: /实时数据/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: /实时数据/ }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refreshNonce 变化后下次打开重新请求（快照增删后的刷新路径）', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => emptyListResponse())
    const { rerender } = render(<SnapshotSelector {...BASE_PROPS} refreshNonce={0} />)

    await user.click(screen.getByRole('button', { name: /实时数据/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await user.keyboard('{Escape}')

    rerender(<SnapshotSelector {...BASE_PROPS} refreshNonce={1} />)
    await user.click(screen.getByRole('button', { name: /实时数据/ }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('projectId 为空时不请求', async () => {
    const user = userEvent.setup()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => emptyListResponse())
    render(<SnapshotSelector {...BASE_PROPS} projectId={null} />)
    await user.click(screen.getByRole('button', { name: /实时数据/ }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
