import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConfirmProvider, useConfirm } from './use-confirm'

function Harness({
  opts,
}: {
  opts: {
    title: string
    description?: string
    inputLabel?: string
    expectedInput?: string
  }
}) {
  const { confirm } = useConfirm()
  return (
    <button
      type="button"
      onClick={() => {
        void confirm(opts)
      }}
    >
      触发
    </button>
  )
}

describe('useConfirm（BLF-468 键入确认扩展）', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('无 expectedInput 时行为不变（向后兼容）：不渲染输入框，确认立即可点', async () => {
    const user = userEvent.setup()
    render(
      <ConfirmProvider>
        <Harness opts={{ title: '停用凭据？', description: '可随时重新激活。' }} />
      </ConfirmProvider>
    )

    await user.click(screen.getByRole('button', { name: '触发' }))
    expect(screen.getByText('停用凭据？')).toBeTruthy()
    expect(screen.queryByLabelText(/确认输入/)).toBeNull()
    expect(screen.getByRole('button', { name: '确认' })).not.toBeDisabled()
  })

  it('设置 expectedInput 后：确认按钮在输入匹配前禁用', async () => {
    const user = userEvent.setup()
    render(
      <ConfirmProvider>
        <Harness
          opts={{
            title: '删除凭据？',
            inputLabel: '请输入 Key 前缀 bbx_ab12 确认删除',
            expectedInput: 'bbx_ab12',
          }}
        />
      </ConfirmProvider>
    )

    await user.click(screen.getByRole('button', { name: '触发' }))
    const input = screen.getByLabelText(/请输入 Key 前缀/) as HTMLInputElement
    const confirmBtn = screen.getByRole('button', { name: '确认' })

    expect(confirmBtn).toBeDisabled()

    await user.type(input, 'bbx_wrong')
    expect(confirmBtn).toBeDisabled()

    await user.clear(input)
    await user.type(input, 'bbx_ab12')
    expect(confirmBtn).not.toBeDisabled()
  })

  it('输入匹配后点击确认关闭弹窗；取消返回 false', async () => {
    const user = userEvent.setup()
    render(
      <ConfirmProvider>
        <Harness
          opts={{
            title: '删除凭据？',
            expectedInput: 'bbx_ab12',
          }}
        />
      </ConfirmProvider>
    )

    await user.click(screen.getByRole('button', { name: '触发' }))
    const input = screen.getByLabelText(/确认输入/)
    await user.type(input, 'bbx_ab12')
    await user.click(screen.getByRole('button', { name: '确认' }))
    expect(screen.queryByText('删除凭据？')).toBeNull()

    // 再次打开并取消
    await user.click(screen.getByRole('button', { name: '触发' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByText('删除凭据？')).toBeNull()
  })
})
