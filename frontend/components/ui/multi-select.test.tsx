import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { MultiSelect } from '@/components/ui/multi-select'

const OPTIONS = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
]

describe('MultiSelect onOpen（BEL-422 按需加载钩子）', () => {
  it('首次打开下拉时触发 onOpen', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(
      <MultiSelect options={OPTIONS} selected={[]} onChange={() => {}} onOpen={onOpen} />
    )

    expect(onOpen).not.toHaveBeenCalled()
    await user.click(screen.getByRole('combobox'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('未打开下拉时不触发 onOpen；关闭再打开会再次触发（父级负责幂等）', async () => {
    const user = userEvent.setup()
    const onOpen = vi.fn()
    render(
      <MultiSelect options={OPTIONS} selected={[]} onChange={() => {}} onOpen={onOpen} />
    )

    const trigger = () => screen.getAllByRole('combobox')[0]
    await user.click(trigger())
    await user.click(trigger())
    await user.click(trigger())
    expect(onOpen).toHaveBeenCalledTimes(2)
  })

  it('不传 onOpen 时行为保持向后兼容', async () => {
    const user = userEvent.setup()
    render(<MultiSelect options={OPTIONS} selected={[]} onChange={() => {}} />)
    await user.click(screen.getByRole('combobox'))
    expect(screen.getByText('A')).toBeInTheDocument()
  })
})
