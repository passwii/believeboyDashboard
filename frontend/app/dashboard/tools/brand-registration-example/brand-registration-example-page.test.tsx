import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import BrandRegistrationExamplePage from './brand-registration-example-page'

describe('BrandRegistrationExamplePage', () => {
  it('展示背景要求、包装产品拍摄要点和精选数量', () => {
    const { container } = render(<BrandRegistrationExamplePage />)

    expect(container.querySelector('[data-tools-page-frame="true"]')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '品牌备案拍摄示例' })).toBeInTheDocument()
    expect(screen.getByText(/干净、颜色单一/)).toBeInTheDocument()
    expect(screen.getByText(/洗标和吊牌/)).toBeInTheDocument()
    expect(screen.getByText(/最终挑选 5 张/)).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: '01 / 包装 · BOX' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: '02 / 产品 · PRODUCT' })
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '拍摄要点' })).toBeInTheDocument()
  })

  it('包装网格有六张、产品网格有四张静态图片', () => {
    render(<BrandRegistrationExamplePage />)

    const boxGrid = screen.getByRole('group', { name: /包装 \/ BOX/ })
    const productGrid = screen.getByRole('group', { name: /产品 \/ PRODUCT/ })

    expect(within(boxGrid).getAllByRole('img')).toHaveLength(6)
    expect(within(productGrid).getAllByRole('img')).toHaveLength(4)
    expect(boxGrid).toHaveAttribute('data-photo-grid', 'box')
    expect(productGrid).toHaveAttribute('data-photo-grid', 'product')
    expect(within(boxGrid).getAllByRole('img').map((image) => image.getAttribute('src'))).toEqual(
      expect.arrayContaining(
        ['box-01.jpg', 'box-02.jpg', 'box-03.jpg', 'box-04.jpg', 'box-05.jpg', 'box-06.jpg'].map(
          (filename) => expect.stringContaining(encodeURIComponent(filename))
        )
      )
    )
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('使用 Warm Tools 面板、静态等分网格，且不混入 Terminal 视觉类', () => {
    const { container } = render(<BrandRegistrationExamplePage />)

    expect(container.querySelector('[data-photo-grid="box"]')).toBeInTheDocument()
    expect(container.querySelector('[data-photo-grid="product"]')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-tools-panel="true"]')).toHaveLength(3)
    expect(container.querySelector('[data-tools-page-frame="true"]')).toBeInTheDocument()
    expect(container.querySelector('[class*="layoutGrid"]')).toBeInTheDocument()
    expect(container.querySelectorAll('img[alt=""]')).toHaveLength(0)
    expect(container.querySelector('[class*="term-"]')).not.toBeInTheDocument()
    expect(container.innerHTML).not.toMatch(/\bTerminal\b/)
  })
})
