import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import userEvent from '@testing-library/user-event'

import SignInCard from './sign-in-card'
import { LoginEntry } from './login-entry'
import { LOGIN_ERROR_HINT_COOKIE, encodeLoginErrorHint } from '@/lib/auth/login-error-hint'

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
  // 清掉上一条用例遗留的排查线索 cookie（登录页读完即清，这里只做隔离）
  document.cookie = `${LOGIN_ERROR_HINT_COOKIE}=; Max-Age=0; Path=/`
})

/** 模拟 authorize 失败时写下的排查线索 cookie（BLF-1383）。 */
function setLoginErrorHint(hint: Parameters<typeof encodeLoginErrorHint>[0]) {
  const value = encodeLoginErrorHint(hint)
  if (!value) throw new Error('hint 编码失败')
  document.cookie = `${LOGIN_ERROR_HINT_COOKIE}=${value}; Path=/`
}

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
  fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'wrong' } })
  fireEvent.click(screen.getByRole('button', { name: /登录/ }))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Smoked Glass 登录页', () => {
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
    render(<LoginEntry />)
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

  it('重试中展示实际最大重试次数', async () => {
    vi.useFakeTimers()
    signInImpl = vi.fn().mockResolvedValue({ error: 'CredentialsSignin', code: 'network_error' })
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))

    await act(async () => { await vi.advanceTimersByTimeAsync(499) })
    expect(screen.getByRole('status')).toHaveTextContent('网络不稳定，正在重试（1/2）…')
    await act(async () => { await vi.advanceTimersByTimeAsync(501) })
    expect(screen.getByRole('status')).toHaveTextContent('网络不稳定，正在重试（2/2）…')
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText(/无法连接到服务器/)).toBeInTheDocument()
    vi.useRealTimers()
  })

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

  it('认证请求 reject 后自动重试并在成功后跳转', async () => {
    signInImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
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

  it('请求超时后会再次尝试，避免登录界面永久等待', async () => {
    vi.useFakeTimers()
    signInImpl = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce({ url: undefined })
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8500)
    })
    expect(signInImpl).toHaveBeenCalledTimes(2)
    expect(replace).toHaveBeenCalledWith('/dashboard')
    vi.useRealTimers()
  })

  it('认证请求在组件卸载后超时，不会发起重试', async () => {
    vi.useFakeTimers()
    signInImpl = vi.fn(() => new Promise(() => {}))
    const { unmount } = render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))
    unmount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000)
    })
    expect(signInImpl).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('认证请求在耗尽重试后展示连接提示且恢复输入', async () => {
    vi.useFakeTimers()
    signInImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000)
    })
    expect(screen.getByText(/无法连接到服务器/)).toBeInTheDocument()
    expect(screen.getByLabelText('企业邮箱')).toBeEnabled()
    expect(signInImpl).toHaveBeenCalledTimes(3)
    expect(replace).not.toHaveBeenCalled()
    errorSpy.mockRestore()
    vi.useRealTimers()
  })

  it('输入框使用 login 专用类且不引入 Terminal token', () => {
    render(<SignInCard />)
    expect(screen.getByLabelText('企业邮箱').className).toContain('login-input')
    expect(screen.getByLabelText('登录密码').className).toContain('login-input')
    expect(screen.getByLabelText('企业邮箱').className).not.toContain('term')
    expect(screen.getByLabelText('登录密码').className).not.toContain('term')
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

  it('登录按钮使用 Warm Ledger 强调色类，不引入 Terminal token', () => {
    render(<SignInCard />)
    const submit = screen.getByRole('button', { name: /登录工作区/ })
    expect(submit.className).toContain('submit-button')
    expect(submit.className).not.toContain('term')
  })

  it('主题切换与密码可见性按钮不使用阴影装饰变体', () => {
    render(<LoginEntry />)
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

  it.each(['success', 'error'] as const)('快速 %s 响应仍展示验证文案至少 500ms', async (outcome) => {
    vi.useFakeTimers()
    signInImpl = vi.fn(async () => outcome === 'error' ? { error: 'CredentialsSignin' } : {})
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: '登录工作区' }))
    expect(screen.getByText('正在验证账号信息，请稍候。')).toBeVisible()
    expect(screen.getByRole('status')).toHaveTextContent('正在安全验证登录信息…')
    expect(screen.getByRole('button', { name: '显示密码' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '正在验证…' })).toHaveAttribute('aria-busy', 'true')
    await act(async () => { await vi.advanceTimersByTimeAsync(499) })
    expect(replace).not.toHaveBeenCalled()
    expect(screen.queryByText(/邮箱或密码错误/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('企业邮箱')).toBeDisabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    if (outcome === 'success') {
      expect(replace).toHaveBeenCalledWith('/dashboard')
    } else {
      expect(screen.getByText(/邮箱或密码错误/)).toBeVisible()
      expect(screen.getByLabelText('企业邮箱')).toBeEnabled()
      expect(screen.getByText('使用企业邮箱和密码继续。')).toBeVisible()
    }
  })

  it('慢响应超过 500ms 后仍等待认证结果，不额外延迟跳转', async () => {
    vi.useFakeTimers()
    const { promise, resolve } = Promise.withResolvers<unknown>()
    signInImpl = vi.fn(() => promise)
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    const form = screen.getByLabelText('企业邮箱').closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(signInImpl).toHaveBeenCalledTimes(1)
    expect(replace).not.toHaveBeenCalled()
    expect(screen.getByLabelText('企业邮箱')).toBeDisabled()
    await act(async () => { resolve({ url: '/dashboard/reports' }) })
    expect(replace).toHaveBeenCalledWith('/dashboard/reports')
  })

  it('最短展示期间卸载会清理计时器，不跳转也不启动全局 loading', async () => {
    vi.useFakeTimers()
    const { unmount } = render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: '登录工作区' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(replace).not.toHaveBeenCalled()
    expect(startGlobalLoading).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('提交中按钮显示“正在验证…”并禁用输入', async () => {
    const { promise, resolve } = Promise.withResolvers<unknown>()
    signInImpl = () => promise
    render(<SignInCard />)
    fireEvent.change(screen.getByLabelText('企业邮箱'), { target: { value: 'a@b.com' } })
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /登录/ }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '正在验证…' })).toBeInTheDocument()
    })
    expect(screen.getByLabelText('企业邮箱')).toBeDisabled()
    await act(async () => {
      resolve({})
    })
  })

  it('密码错时展示具体凭据提示', async () => {
    signInImpl = async () => ({ error: 'CredentialsSignin', code: 'invalid_credentials' })
    render(<SignInCard />)
    fillAndSubmit()

    expect(await screen.findByText(/邮箱或密码错误，请检查大小写与键盘输入法/)).toBeInTheDocument()
  })

  it('账号停用时提示停用而不是密码错', async () => {
    signInImpl = async () => ({ error: 'CredentialsSignin', code: 'account_disabled' })
    render(<SignInCard />)
    fillAndSubmit()

    expect(await screen.findByText(/账号已停用，请联系管理员/)).toBeInTheDocument()
    expect(screen.queryByText(/邮箱或密码错误/)).not.toBeInTheDocument()
  })

  it('后端 500 展示内部错误与请求 ID，不再说后端连接错误', async () => {
    signInImpl = async () => ({ error: 'CredentialsSignin', code: 'internal_error' })
    setLoginErrorHint({ backendCode: 'LOGIN_INTERNAL_ERROR', requestId: '9f2c1a8e77aa4d3f' })
    render(<SignInCard />)
    fillAndSubmit()

    const message = await screen.findByText(/登录服务内部错误/)
    expect(message).toHaveTextContent('错误码 LOGIN_INTERNAL_ERROR')
    expect(message).toHaveTextContent('请求 ID 9f2c1a8e')
    expect(screen.queryByText(/无法连接到服务器/)).not.toBeInTheDocument()
    expect(screen.queryByText(/邮箱或密码错误/)).not.toBeInTheDocument()
  })

  it('限流时按 retry_after_seconds 倒计时，且不自动重试', async () => {
    vi.useFakeTimers()
    const signInMock = vi.fn(async () => ({ error: 'CredentialsSignin', code: 'rate_limited' }))
    signInImpl = signInMock
    setLoginErrorHint({ backendCode: 'LOGIN_RATE_LIMITED', retryAfterSeconds: 30 })
    render(<SignInCard />)
    fillAndSubmit()

    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(screen.getByText('登录失败次数过多，请 30 秒后重试。')).toBeInTheDocument()
    expect(signInMock).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByText('登录失败次数过多，请 29 秒后重试。')).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('限流但拿不到剩余秒数时退化成静态文案', async () => {
    signInImpl = async () => ({ error: 'CredentialsSignin', code: 'rate_limited' })
    render(<SignInCard />)
    fillAndSubmit()

    expect(await screen.findByText('登录失败次数过多，请稍后重试。')).toBeInTheDocument()
  })

  it('未知 code 不归因为密码错误', async () => {
    signInImpl = async () => ({ error: 'CredentialsSignin', code: 'brand_new_reason' })
    setLoginErrorHint({ backendCode: 'LOGIN_SOMETHING_NEW', requestId: 'abc12345deadbeef' })
    render(<SignInCard />)
    fillAndSubmit()

    const message = await screen.findByText(/登录未成功，请稍后重试/)
    expect(message).toHaveTextContent('错误码 LOGIN_SOMETHING_NEW')
    expect(screen.queryByText(/邮箱或密码错误/)).not.toBeInTheDocument()
    expect(screen.queryByText(/无法连接到服务器/)).not.toBeInTheDocument()
  })

  it('后端给了不认识的 code 时也不归因为密码错误，并附后端错误码', async () => {
    signInImpl = async () => ({ error: 'CredentialsSignin', code: 'unknown_backend_reason' })
    setLoginErrorHint({ backendCode: 'LOGIN_MFA_REQUIRED', requestId: 'abc12345deadbeef' })
    render(<SignInCard />)
    fillAndSubmit()

    const message = await screen.findByText(/登录未成功，请稍后重试或联系管理员/)
    expect(message).toHaveTextContent('错误码 LOGIN_MFA_REQUIRED')
    expect(message).toHaveTextContent('请求 ID abc12345')
    expect(screen.queryByText(/邮箱或密码错误/)).not.toBeInTheDocument()
  })

  it('限流倒计时归零后展示静态文案且停止每秒空转', async () => {
    vi.useFakeTimers()
    const clearSpy = vi.spyOn(window, 'clearInterval')
    signInImpl = async () => ({ error: 'CredentialsSignin', code: 'rate_limited' })
    setLoginErrorHint({ backendCode: 'LOGIN_RATE_LIMITED', retryAfterSeconds: 2 })
    render(<SignInCard />)
    fillAndSubmit()

    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(screen.getByText('登录失败次数过多，请 2 秒后重试。')).toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(screen.getByText('登录失败次数过多，请稍后重试。')).toBeInTheDocument()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })

  it('登录成功后清掉上一条失败的 hint cookie，不会带到下一次失败', async () => {
    signInImpl = async () => ({ url: undefined })
    setLoginErrorHint({ backendCode: 'LOGIN_INTERNAL_ERROR', requestId: 'abc12345deadbeef' })
    render(<SignInCard />)
    fillAndSubmit()

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/dashboard'))
    expect(document.cookie).not.toContain(LOGIN_ERROR_HINT_COOKIE)
  })

  it('认证确定失败时只尝试一次，不触发自动重试', async () => {
    const signInMock = vi.fn(async () => ({ error: 'CredentialsSignin', code: 'invalid_credentials' }))
    signInImpl = signInMock
    render(<SignInCard />)
    fillAndSubmit()

    await screen.findByText(/邮箱或密码错误，请检查大小写与键盘输入法/)
    expect(signInMock).toHaveBeenCalledTimes(1)
  })
})
