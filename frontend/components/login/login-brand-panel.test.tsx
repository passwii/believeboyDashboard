import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LoginBrandPanel } from './login-brand-panel'
import { LoginEntry } from './login-entry'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
}))
vi.mock('@/components/global-loading-provider', () => ({
  useGlobalLoading: () => ({ startGlobalLoading: vi.fn(), endGlobalLoading: vi.fn() }),
}))

describe('LoginBrandPanel', () => {
  it('保留确认的品牌文案、飞翼标识，不再展示工作区目录', () => {
    const { container } = render(<LoginBrandPanel />)
    expect(screen.getByRole('heading', { level: 1, name: /跨境电商\s*运营工作区/ })).toBeVisible()
    expect(screen.getByText('把日常运营与数据，集中在一个工作区。')).toBeVisible()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.queryByText('工作区地图')).not.toBeInTheDocument()
    expect(container.querySelector('.route-art')).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelectorAll('.route-wire-live')).toHaveLength(2)
    expect(screen.queryByText(/会话已建立|认证服务可达|延迟\s*\d+ms/)).not.toBeInTheDocument()
  })

  it('整个登录页保留主题按钮与移动端品牌区域', () => {
    const { container } = render(<LoginEntry />)
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content')
    expect(screen.getByLabelText('BelieveBoy')).toBeVisible()
    expect(container.querySelector('.brand-panel')).toBeInTheDocument()
    expect(container.querySelector('.brand-head .brand-mark svg rect')).toHaveAttribute('fill', '#2755d9')
    expect(container.querySelector('.login-slab .brand-panel')).toBeInTheDocument()
    expect(container.querySelector('.login-slab .form-panel')).toBeInTheDocument()
    expect(container.querySelector('.form-panel-top .theme-button')).toBeInTheDocument()
  })
})
