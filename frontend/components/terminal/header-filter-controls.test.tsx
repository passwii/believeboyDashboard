import * as React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { HeaderFilterControls } from './header-filter-controls'

/**
 * HeaderFilterControls —— Top Header 中段插槽内容统一容器。
 * 两形态：≥md 平铺（flex-nowrap 单行）；<md 折叠为「筛选」Popover。
 */

const controls = (
  <>
    <span>项目筛选</span>
    <span>站点筛选</span>
  </>
)

describe('HeaderFilterControls', () => {
  it('桌面形态：控件平铺渲染，无 Popover 触发器', () => {
    render(<HeaderFilterControls isMobileView={false} controls={controls} />)
    expect(screen.getByText('项目筛选')).toBeInTheDocument()
    expect(screen.getByText('站点筛选')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '页面筛选' })).not.toBeInTheDocument()
  })

  it('移动形态：折叠为「筛选」Popover，点击展开控件', async () => {
    const user = userEvent.setup()
    render(<HeaderFilterControls isMobileView controls={controls} />)

    // 折叠态：控件不在文档中，只有触发器
    expect(screen.queryByText('项目筛选')).not.toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: '页面筛选' })
    expect(trigger).toBeInTheDocument()

    // 展开态：控件出现在弹层
    await user.click(trigger)
    expect(await screen.findByText('项目筛选')).toBeInTheDocument()
    expect(screen.getByText('站点筛选')).toBeInTheDocument()
  })
})
