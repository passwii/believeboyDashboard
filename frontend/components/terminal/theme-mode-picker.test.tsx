import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const themeState = vi.hoisted(() => ({
  theme: 'system' as string | undefined,
  resolvedTheme: 'light',
  setTheme: vi.fn(),
}))

vi.mock('next-themes', () => ({
  useTheme: () => themeState,
}))

import { ThemeModePicker } from './theme-mode-picker'

describe('ThemeModePicker', () => {
  beforeEach(() => {
    themeState.theme = 'system'
    themeState.resolvedTheme = 'light'
    themeState.setTheme.mockReset()
    document.documentElement.removeAttribute('data-theme-transition')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('桌面鼠标悬停时打开三态菜单并标记当前模式', async () => {
    render(<ThemeModePicker placement="rail" />)

    fireEvent.pointerEnter(screen.getByRole('button', { name: '主题设置：自动' }), {
      pointerType: 'mouse',
    })

    expect(await screen.findByRole('menuitemradio', { name: /自动/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByRole('menuitemradio', { name: /浅色/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /深色/ })).toBeInTheDocument()
  })

  it('桌面入口在 hydration 前后维持相同尺寸的主题按钮', () => {
    const { rerender } = render(<ThemeModePicker placement="rail" />)
    const initialButton = screen.getByRole('button', { name: '主题设置：自动' })
    expect(initialButton).toHaveClass('h-9', 'w-9')

    act(() => rerender(<ThemeModePicker placement="rail" />))
    expect(screen.getByRole('button', { name: '主题设置：自动' })).toHaveClass('h-9', 'w-9')
  })

  it('桌面 hover 展开时不抢走当前焦点', async () => {
    render(
      <>
        <button type="button">其他操作</button>
        <ThemeModePicker placement="rail" />
      </>
    )
    const otherButton = screen.getByRole('button', { name: '其他操作' })
    otherButton.focus()
    fireEvent.pointerEnter(screen.getByRole('button', { name: '主题设置：自动' }), {
      pointerType: 'mouse',
    })

    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(otherButton).toHaveFocus()
  })

  it('主题按钮有键盘焦点时 hover 打开的菜单可由键盘接管', async () => {
    const user = userEvent.setup()
    render(<ThemeModePicker placement="rail" />)
    const trigger = screen.getByRole('button', { name: '主题设置：自动' })
    trigger.focus()
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })

    const menu = await screen.findByRole('menu')
    expect(menu).toHaveFocus()

    await user.keyboard('{ArrowDown}{Enter}')

    expect(themeState.setTheme).toHaveBeenCalledWith('light')
  })

  it('鼠标尚未悬停展开时点击触发器仍可打开菜单', () => {
    render(<ThemeModePicker placement="rail" />)
    const trigger = screen.getByRole('button', { name: '主题设置：自动' })

    fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 })
    fireEvent.click(trigger)

    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('悬停打开后第一次点击保留菜单，再次点击可关闭', async () => {
    vi.useFakeTimers()
    render(<ThemeModePicker placement="rail" />)
    const trigger = screen.getByRole('button', { name: '主题设置：自动' })
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(100))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 })
    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 })
    fireEvent.click(trigger)

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it.each([
    ['浅色', 'light', 'system'],
    ['深色', 'dark', 'system'],
    ['自动（跟随系统）', 'system', 'light'],
  ])('选择“%s”后设置 %s 模式', async (label, value, initialMode) => {
    themeState.theme = initialMode
    const user = userEvent.setup()
    render(<ThemeModePicker placement="rail" />)
    await user.click(screen.getByRole('button', { name: `主题设置：${initialMode === 'light' ? '浅色' : '自动'}` }))
    await user.click(screen.getByRole('menuitemradio', { name: new RegExp(label) }))

    expect(themeState.setTheme).toHaveBeenCalledWith(value)
    expect(document.documentElement).toHaveAttribute('data-theme-transition', 'true')
  })

  it('鼠标从触发器移入菜单时取消关闭，离开菜单后延迟关闭', async () => {
    vi.useFakeTimers()
    render(<ThemeModePicker placement="rail" />)
    const trigger = screen.getByRole('button', { name: '主题设置：自动' })
    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(100))

    const menu = screen.getByRole('menu')
    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' })
    fireEvent.pointerEnter(menu, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(250))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.pointerLeave(menu, { pointerType: 'mouse' })
    act(() => vi.advanceTimersByTime(100))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(200))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('移动入口通过点击打开菜单，并在选择后更新主题', async () => {
    const user = userEvent.setup()
    render(<ThemeModePicker placement="mobile" />)
    await user.click(screen.getByRole('button', { name: '外观：自动' }))
    await user.click(screen.getByRole('menuitemradio', { name: /深色/ }))

    expect(themeState.setTheme).toHaveBeenCalledWith('dark')
  })

  it('按 Escape 关闭菜单', async () => {
    const user = userEvent.setup()
    render(<ThemeModePicker placement="mobile" />)
    await user.click(screen.getByRole('button', { name: '外观：自动' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('点击已由点击打开的桌面主题按钮可关闭菜单', async () => {
    const user = userEvent.setup()
    render(<ThemeModePicker placement="rail" />)
    const trigger = screen.getByRole('button', { name: '主题设置：自动' })
    await user.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await user.click(trigger)

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('选择当前模式不重复设置主题或启动过渡', async () => {
    themeState.theme = 'light'
    const user = userEvent.setup()
    render(<ThemeModePicker placement="rail" />)
    await user.click(screen.getByRole('button', { name: '主题设置：浅色' }))
    await user.click(screen.getByRole('menuitemradio', { name: /浅色/ }))

    expect(themeState.setTheme).not.toHaveBeenCalled()
    expect(document.documentElement).not.toHaveAttribute('data-theme-transition')
  })

  it('同一全局页面中的桌面和移动入口均可通过选择打开并共享当前模式', async () => {
    const user = userEvent.setup()
    render(
      <>
        <ThemeModePicker placement="rail" />
        <ThemeModePicker placement="mobile" />
      </>
    )
    await user.click(screen.getByRole('button', { name: '主题设置：自动' }))
    expect(screen.getByRole('menuitemradio', { name: /自动/ })).toHaveAttribute('aria-checked', 'true')
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: '外观：自动' }))
    await user.click(screen.getByRole('menuitemradio', { name: /深色/ }))

    expect(themeState.setTheme).toHaveBeenCalledWith('dark')
  })

  it('系统减少动态效果时不添加页面过渡状态', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
    themeState.theme = 'light'
    const user = userEvent.setup()
    render(<ThemeModePicker placement="mobile" />)
    await user.click(screen.getByRole('button', { name: '外观：浅色' }))
    await user.click(screen.getByRole('menuitemradio', { name: /深色/ }))

    expect(themeState.setTheme).toHaveBeenCalledWith('dark')
    expect(document.documentElement).not.toHaveAttribute('data-theme-transition')
  })

})
