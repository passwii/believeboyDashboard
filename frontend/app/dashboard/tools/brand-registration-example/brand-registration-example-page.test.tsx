import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import BrandRegistrationExamplePage from './brand-registration-example-page'

describe('BrandRegistrationExamplePage', () => {
  it('展示背景要求、包装产品拍摄要点和精选数量', () => {
    render(<BrandRegistrationExamplePage />)

    expect(screen.getByRole('heading', { name: '品牌备案拍摄示例' })).toBeInTheDocument()
    expect(screen.getByText(/干净、颜色单一/)).toBeInTheDocument()
    expect(screen.getByText(/洗标和吊牌/)).toBeInTheDocument()
    expect(screen.getByText(/最终挑选 5 张/)).toBeInTheDocument()
  })

  it('包装网格有六张、产品网格有四张静态图片', () => {
    render(<BrandRegistrationExamplePage />)

    const boxGrid = screen.getByRole('group', { name: /包装 \/ BOX/ })
    const productGrid = screen.getByRole('group', { name: /产品 \/ PRODUCT/ })

    expect(within(boxGrid).getAllByRole('img')).toHaveLength(6)
    expect(within(productGrid).getAllByRole('img')).toHaveLength(4)
    expect(boxGrid).toHaveClass('grid-cols-2', 'md:grid-cols-3')
    expect(productGrid).toHaveClass('grid-cols-2')
    expect(within(boxGrid).getAllByRole('img').map((image) => image.getAttribute('src'))).toEqual(
      expect.arrayContaining(
        ['box-01.jpg', 'box-02.jpg', 'box-03.jpg', 'box-04.jpg', 'box-05.jpg', 'box-06.jpg'].map(
          (filename) => expect.stringContaining(encodeURIComponent(filename))
        )
      )
    )
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('使用 Terminal 令牌、零圆角、零阴影和静态等分网格', () => {
    const { container } = render(<BrandRegistrationExamplePage />)

    expect(container.querySelector('.grid-cols-2.gap-2.md\\:grid-cols-3')).toBeInTheDocument()
    expect(container.querySelector('.rounded-none.border-term-border.bg-term-panel.shadow-none')).toBeInTheDocument()
    expect(container.firstElementChild?.className).toContain('gap-2')
    expect(container.querySelector('[class*="layoutContainer"]')).toBeInTheDocument()
    expect(container.querySelector('[class*="layoutGrid"]')).toBeInTheDocument()
    expect(container.querySelectorAll('img[alt=""]')).toHaveLength(0)
  })
})
