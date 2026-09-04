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

describe('Terminal 登录页（BLF-965 精细化）', () => {
  it('渲染终端窗口壳：中文页签 / 状态栏会话正常', () => {
    render(<SignInCard />)
    expect(screen.getByText('登录 — zsh')).toBeInTheDocument()
    expect(screen.getByText('— zsh — 80×24')).toBeInTheDocument()
    expect(screen.getByText(/会话正常/)).toBeInTheDocument()
    expect(screen.getByLabelText('登录终端')).toBeInTheDocument()
  })

  it('表单中文优先：可见标签 + 中文提交按钮，命令仅注释点缀', () => {
    render(<SignInCard />)
    // 可见中文 label（非 sr-only）
    expect(screen.getByText('企业邮箱')).toBeVisible()
    expect(screen.getByText('登录密码')).toBeVisible()
    // 提交按钮中文为主
    const submit = screen.getByRole('button', { name: /登录/ })
    expect(submit).toBeInTheDocument()
    expect(submit.textContent).toContain('登录')
    // 命令注释仍在（点缀，不主导）
    expect(screen.getByText('# believeboy login')).toBeInTheDocument()
  })

  it('boot 输出全中文：会话建立与认证服务可达', () => {
    const { container } = render(<BootSequence />)
    expect(container.textContent).toContain('会话已建立')
    expect(container.textContent).toContain('认证服务可达')
    expect(container.textContent).not.toContain('session established')
  })

  it('主题切换按钮存在并可点击', async () => {
    const user = userEvent.setup()
    render(<TerminalWindow>body</TerminalWindow>)
    const toggle = await screen.findByRole('button', { name: /切换到深色模式/ })
    await user.click(toggle)
    expect(toggle).toBeInTheDocument()
  })

  it('登录失败时以 ✗ 行内输出中文错误，不跳转', async () => {
    signInImpl = async () => ({ error: 'CredentialsSignin' })
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))
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
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/dashboard')
    })
  })

  it('提交中按钮显示“登录中…”并禁用输入', async () => {
    const { promise, resolve } = Promise.withResolvers<unknown>()
    signInImpl = () => promise
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => {
      expect(screen.getByText(/登录中/)).toBeInTheDocument()
    })
    expect(screen.getByLabelText('企业邮箱')).toBeDisabled()
    resolve({})
  })
})
