import { act, render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { CrmSearchInput } from './crm-search-input'

describe('CrmSearchInput', () => {
  afterEach(() => vi.useRealTimers())

  it('输入防抖后触发 onChange', () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    render(<CrmSearchInput value="" onChange={onChange} placeholder="搜索" />)
    fireEvent.change(screen.getByPlaceholderText('搜索'), { target: { value: '甲' } })
    expect(onChange).not.toHaveBeenCalledWith('甲') // 未防抖完
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(onChange).toHaveBeenCalledWith('甲')
  })

  it('外部 value 变化同步到输入框', () => {
    const { rerender } = render(<CrmSearchInput value="" onChange={() => {}} placeholder="搜索" />)
    rerender(<CrmSearchInput value="外部" onChange={() => {}} placeholder="搜索" />)
    expect((screen.getByPlaceholderText('搜索') as HTMLInputElement).value).toBe('外部')
  })

  it('有文本时显示清空按钮，点击清空输入框', () => {
    render(<CrmSearchInput value="" onChange={() => {}} placeholder="搜索" />)
    fireEvent.change(screen.getByPlaceholderText('搜索'), { target: { value: '甲' } })
    expect(screen.getByLabelText('清空搜索')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('清空搜索'))
    expect((screen.getByPlaceholderText('搜索') as HTMLInputElement).value).toBe('')
  })
})
