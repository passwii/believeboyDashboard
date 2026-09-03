import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'

import SignInCard from './sign-in-card'
import TerminalWindow from './terminal-window'
import BootSequence from './boot-sequence'

const replace = vi.fn()
const startGlobalLoading = vi.fn()
const endGlobalLoading = vi.fn()
let signInImpl: (...args: unknown[]) => Promise<unknown> = async () => ({})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => ({ get: () => null }),
}))

vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInImpl(...args),
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light', setTheme: vi.fn() }),
}))

vi.mock('@/components/global-loading-provider', () => ({
  useGlobalLoading: () => ({ startGlobalLoading, endGlobalLoading }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  signInImpl = async () => ({})
})

describe('Terminal 登录页（BLF-965）', () => {
  it('渲染终端窗口壳：标题栏 / 页签 / 状态栏', () => {
    render(<SignInCard />)
    expect(screen.getByText('login — zsh')).toBeInTheDocument()
    expect(screen.getByText('— zsh — 80×24')).toBeInTheDocument()
    expect(screen.getByLabelText('登录终端')).toBeInTheDocument()
  })

  it('渲染命令式表单：email / password 输入与 $ 提交按钮', () => {
    render(<SignInCard />)
    expect(screen.getByLabelText('企业邮箱')).toBeInTheDocument()
    expect(screen.getByLabelText('登录密码')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /auth --submit/ })).toBeInTheDocument()
  })

  it('boot 输出包含会话建立与 idp 可达行', () => {
    const { container } = render(<BootSequence />)
    expect(container.textContent).toContain('session established')
    expect(container.textContent).toContain('idp reachable')
  })

  it('主题切换按钮存在并可点击', async () => {
    const user = userEvent.setup()
    render(<TerminalWindow>body</TerminalWindow>)
    const toggle = await screen.findByRole('button', { name: /切换到深色模式/ })
    await user.click(toggle)
    expect(toggle).toBeInTheDocument()
  })

  it('登录失败时以 ✗ 行内输出错误，不跳转', async () => {
    signInImpl = async () => ({ error: 'CredentialsSignin' })
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: /auth --submit/ }))
    await waitFor(() => {
      expect(screen.getByText(/邮箱或密码错误/)).toBeInTheDocument()
    })
    expect(replace).not.toHaveBeenCalled()
  })

  it('登录成功时跳转默认 dashboard', async () => {
    signInImpl = async () => ({ url: undefined })
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /auth --submit/ }))
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/dashboard')
    })
  })
})
