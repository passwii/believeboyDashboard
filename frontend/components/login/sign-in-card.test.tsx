import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'

import SignInCard from './sign-in-card'
import { LoginThemeToggle } from './login-theme-toggle'

const replace = vi.fn()
const startGlobalLoading = vi.fn()
const endGlobalLoading = vi.fn()
let callbackUrl: string | null = null
let signInImpl: (...args: unknown[]) => Promise<unknown> = async () => ({})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => ({ get: (key: string) => (key === 'callbackUrl' ? callbackUrl : null) }),
}))

vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInImpl(...args),
}))

vi.mock('./login-theme-toggle', () => ({
  LoginThemeToggle: () => <button type="button" aria-label="切换到深色模式" />,
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light', setTheme: vi.fn() }),
}))

vi.mock('@/components/global-loading-provider', () => ({
  useGlobalLoading: () => ({ startGlobalLoading, endGlobalLoading }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  callbackUrl = null
  signInImpl = async () => ({})
})

describe('Terminal 登录页（BLF-965 精细化）', () => {
  it('表单是主要认证操作且保留可见字段标签', () => {
    render(<SignInCard />)
    expect(screen.getByRole('heading', { level: 2, name: '登录工作区' })).toBeVisible()
    expect(screen.getByText('企业邮箱')).toBeVisible()
    expect(screen.getByText('登录密码')).toBeVisible()
    expect(screen.getByRole('button', { name: /登录工作区/ })).toBeInTheDocument()
  })

  it('页面不呈现未经确认的实时认证状态或延迟数据', () => {
    render(<SignInCard />)
    expect(screen.queryByText(/会话已建立|认证服务可达|延迟\s*\d+ms/)).not.toBeInTheDocument()
  })

  it('主题切换按钮存在并可点击', async () => {
    const user = userEvent.setup()
    render(<SignInCard />)
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

  it('登录成功时保留站内 callback 的路径、查询和片段', async () => {
    callbackUrl = '/dashboard/reports?range=7d#summary'
    signInImpl = async () => ({ url: undefined })
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/dashboard/reports?range=7d#summary')
    })
  })

  it('登录成功时不会跳转到站外 callback URL', async () => {
    callbackUrl = 'https://attacker.example/phishing'
    signInImpl = async () => ({ url: undefined })
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/dashboard')
    })
  })

  it('登录成功时不会将协议相对 callback URL 用作站外跳转', async () => {
    callbackUrl = '//attacker.example/phishing'
    signInImpl = async () => ({ url: undefined })
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/dashboard')
    })
  })

  it('认证失败时不启动导航加载状态', async () => {
    signInImpl = async () => ({ error: 'CredentialsSignin' })
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))

    await screen.findByText(/邮箱或密码错误/)
    expect(startGlobalLoading).not.toHaveBeenCalled()
  })

  it('认证成功后只启动一次导航加载并在卸载时结束', async () => {
    signInImpl = async () => ({ url: undefined })
    const { unmount } = render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/dashboard')
    })
    expect(startGlobalLoading).toHaveBeenCalledTimes(1)
    unmount()
    expect(endGlobalLoading).toHaveBeenCalledWith('navigation')
  })

  it('邮箱字段保留浏览器邮箱自动填充语义', () => {
    render(<SignInCard />)
    expect(screen.getByLabelText('企业邮箱')).toHaveAttribute('id', 'email')
    expect(screen.getByLabelText('企业邮箱')).toHaveAttribute('autoComplete', 'email')
  })

  it('认证网络错误展示可恢复的连接提示', async () => {
    signInImpl = async () => ({ error: 'CredentialsSignin', code: 'network_error' })
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))

    expect(await screen.findByText(/无法连接到服务器/, {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByLabelText('企业邮箱')).toBeEnabled()
    expect(replace).not.toHaveBeenCalled()
  }, 7000)

  it('网络错误后自动重试并在登录成功后继续跳转', async () => {
    signInImpl = vi
      .fn()
      .mockResolvedValueOnce({ error: 'CredentialsSignin', code: 'network_error' })
      .mockResolvedValueOnce({ url: undefined })
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))

    await waitFor(() => {
      expect(signInImpl).toHaveBeenCalledTimes(2)
      expect(replace).toHaveBeenCalledWith('/dashboard')
    })
  })

  it('认证请求 reject 时展示连接提示且恢复输入', async () => {
    signInImpl = async () => {
      throw new Error('fetch failed')
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))

    expect(await screen.findByText(/无法连接到服务器/)).toBeInTheDocument()
    expect(screen.getByLabelText('企业邮箱')).toBeEnabled()
    expect(replace).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('输入占位文字使用专用的高对比度令牌', () => {
    render(<SignInCard />)
    expect(screen.getByLabelText('企业邮箱').className).toContain('placeholder:text-term-placeholder')
    expect(screen.getByLabelText('登录密码').className).toContain('placeholder:text-term-placeholder')
  })

  it('输入框 hover 不产生位移：不带 u-interactive 上浮与任何 transform 工具类', () => {
    render(<SignInCard />)
    for (const label of ['企业邮箱', '登录密码']) {
      const input = screen.getByLabelText(label)
      expect(input.className).not.toContain('u-interactive')
      expect(input.className).not.toMatch(/(^|\s)-?translate[-\s]|scale-\[|hover:-?translate/)
    }
    // 输入框内的密码可见性按钮也不做按压缩放，只保留底色/取色反馈
    expect(screen.getByRole('button', { name: '显示密码' }).className).not.toMatch(/active:scale/)
  })

  it('登录按钮文字在 light 与 dark 主题均保持高对比度', () => {
    render(<SignInCard />)
    const submit = screen.getByRole('button', { name: /登录工作区/ })
    expect(submit.className).toContain('bg-term-action')
    expect(submit.className).toContain('text-term-action-text')
  })

  it('主题切换与密码可见性按钮不使用阴影装饰变体', () => {
    render(<SignInCard />)
    expect(screen.getByRole('button', { name: /切换到深色模式/ })).toBeInTheDocument()
    const passwordToggle = screen.getByRole('button', { name: '显示密码' })
    expect(passwordToggle.className).not.toContain('u-btn')
  })

  it('密码可见性按钮能切换密码显示状态', async () => {
    const user = userEvent.setup()
    render(<SignInCard />)
    const password = screen.getByLabelText('登录密码')
    await user.click(screen.getByRole('button', { name: '显示密码' }))
    expect(password).toHaveAttribute('type', 'text')
    await user.click(screen.getByRole('button', { name: '隐藏密码' }))
    expect(password).toHaveAttribute('type', 'password')
  })

  it('提交中按钮显示“正在验证…”并禁用输入', async () => {
    const { promise, resolve } = Promise.withResolvers<unknown>()
    signInImpl = () => promise
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => {
      expect(screen.getByText(/正在验证/)).toBeInTheDocument()
    })
    expect(screen.getByLabelText('企业邮箱')).toBeDisabled()
    resolve({})
  })
})
