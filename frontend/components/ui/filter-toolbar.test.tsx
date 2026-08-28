import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { FilterToolbar } from './filter-toolbar'

describe('FilterToolbar', () => {
  it('渲染 children 字段与右侧 actions', () => {
    render(
      <FilterToolbar actions={<button type="button">刷新</button>}>
        <select aria-label="项目" />
        <select aria-label="国家" />
      </FilterToolbar>
    )
    expect(screen.getByLabelText('项目')).toBeInTheDocument()
    expect(screen.getByLabelText('国家')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument()
  })

  it('容器使用 dashboard-toolbar 表面（BLF-873：term 表面由 CSS 统一定义，组件不再叠加玻璃态内边距）', () => {
    const { container } = render(<FilterToolbar>字段</FilterToolbar>)
    const toolbar = container.querySelector('.dashboard-toolbar')
    expect(toolbar).toBeTruthy()
    expect(toolbar?.className).not.toContain('px-4')
    expect(toolbar?.className).not.toContain('lg:px-6')
  })

  it('默认手机端折叠为 2 列网格、桌面横向 flex（移动规则 2），间距统一 gap-2', () => {
    const { container } = render(<FilterToolbar>字段</FilterToolbar>)
    const content = container.querySelector('.dashboard-toolbar > div')
    expect(content?.className).toContain('grid-cols-2')
    expect(content?.className).toContain('md:flex')
    expect(content?.className).toContain('gap-2')
    expect(content?.className).toContain('md:gap-2')
    expect(content?.className).not.toContain('md:gap-3')
  })

  it('actions 手机端占满一行（col-span-2）、桌面靠右（md:ml-auto）', () => {
    const { container } = render(
      <FilterToolbar actions={<button type="button">刷新</button>}>字段</FilterToolbar>
    )
    const actions = container.querySelector('.dashboard-toolbar > div > div')
    expect(actions?.className).toContain('col-span-2')
    expect(actions?.className).toContain('md:ml-auto')
  })

  it('mobileGrid=false 时保持纯 flex 不折叠', () => {
    const { container } = render(<FilterToolbar mobileGrid={false}>字段</FilterToolbar>)
    const content = container.querySelector('.dashboard-toolbar > div')
    expect(content?.className).not.toContain('grid-cols-2')
    expect(content?.className).toContain('flex')
  })
})
