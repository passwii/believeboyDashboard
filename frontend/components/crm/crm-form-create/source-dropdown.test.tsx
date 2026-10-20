import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CrmFormCreate } from './index'

/**
 * BLF-1409：客户新建表单「来源」下拉必须出现「自主开发」。
 * 之前该验收点只有 schema 层断言，UI 渲染层未覆盖 → 此用例补齐。
 */
describe('CrmFormCreate 来源下拉', () => {
  it('下拉里出现「自主开发」，且可选中并提交 self_developed', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<CrmFormCreate users={[]} onSubmit={onSubmit} />)

    // Radix Select 需要 pointerdown 序列才能展开
    const trigger = screen.getByRole('combobox', { name: /来源/ })
    await user.click(trigger)

    const option = await screen.findByRole('option', { name: '自主开发' })
    expect(option).toBeTruthy()

    // 其余 5 个既有来源仍应存在
    for (const label of ['转介绍', '展会', '线上广告', '陌拜', '其他']) {
      expect(screen.getByRole('option', { name: label })).toBeTruthy()
    }

    await user.click(option)

    // 选中后填必填项并提交，断言 payload 用的是 self_developed
    const nameInput = screen.getByLabelText(/客户名/)
    await user.clear(nameInput)
    await user.type(nameInput, '甲公司')
    await user.click(screen.getByRole('button', { name: /保存/ }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0].source).toBe('self_developed')
  })
})
