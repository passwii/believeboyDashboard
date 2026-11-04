import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import PageRenderLoading from './loading'

describe('PageRenderLoading', () => {
  it('uses the shared Warm Tools loading frame', () => {
    render(<PageRenderLoading />)

    expect(screen.getByTestId('tools-loading')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('工具箱页面加载中')
  })
})
