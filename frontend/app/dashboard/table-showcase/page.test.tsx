import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import TableShowcasePage from '@/app/dashboard/table-showcase/page'

// 冒烟：定稿后的 showcase 页（基线 + 变体 + 规范速览 + 差异表）在 jsdom 下可渲染，
// 防止 framer-motion / DataTableFrame 组合引入运行时崩溃。
describe('table-showcase 定稿页', () => {
  it('渲染规范速览、基线、变体与差异表', () => {
    render(<TableShowcasePage />)
    // 规范速览
    expect(screen.getByText('表格规范速览')).toBeInTheDocument()
    expect(screen.getByText('密度档位')).toBeInTheDocument()
    // 基线（高密度数据网格）
    expect(screen.getByText('基线 · 高密度数据网格（全站默认）')).toBeInTheDocument()
    // 变体 A / C
    expect(screen.getByText('宽松密度（cozy）· 展示型')).toBeInTheDocument()
    expect(screen.getByText('动效增强（行展开）· 占位')).toBeInTheDocument()
    // 方向差异表（section 标题 + 卡片标题各一处）
    expect(screen.getAllByText('方向差异表').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('适用场景')).toBeInTheDocument()
    // mock 数据渲染（基线表格行）
    expect(screen.getAllByText(/INV-\d{4}/).length).toBeGreaterThan(0)
  })
})
