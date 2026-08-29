import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from './breadcrumb'

describe('Breadcrumb Terminal 收口（BLF-873）', () => {
  it('列表基座：mono 小字 + term 色阶（对齐 TerminalHeader 面包屑）', () => {
    const { container } = render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/dashboard">运营</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>库存台账</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    )
    const list = container.querySelector('ol')
    expect(list?.className).toContain('font-mono')
    expect(list?.className).toContain('text-xs')
    expect(list?.className).toContain('text-term-muted')
    expect(screen.getByRole('navigation')).toBeInTheDocument()
  })

  it('默认分隔符为 › 单字符（term-faint），不再用 ChevronRight 图标', () => {
    const { container } = render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbSeparator />
        </BreadcrumbList>
      </Breadcrumb>
    )
    const separator = container.querySelector('li[aria-hidden="true"]')
    expect(separator?.textContent).toBe('›')
    expect(separator?.className).toContain('text-term-faint')
    expect(container.querySelector('svg')).toBeNull()
  })

  it('当前页走 term-text + 收紧字距', () => {
    render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>库存台账</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    )
    const page = screen.getByText('库存台账')
    expect(page.className).toContain('text-term-text')
    expect(page.className).toContain('tracking-tight')
  })

  it('省略号占位对齐 h-9 节奏（BLF-887 上档）且零圆角', () => {
    const { container } = render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbEllipsis />
        </BreadcrumbList>
      </Breadcrumb>
    )
    const ellipsis = container.querySelector('span[aria-hidden="true"]')
    expect(ellipsis?.className).toContain('h-9')
    expect(ellipsis?.className).toContain('w-9')
    expect(ellipsis?.className).toContain('rounded-none')
    expect(ellipsis?.className).not.toContain('h-10')
  })
})
