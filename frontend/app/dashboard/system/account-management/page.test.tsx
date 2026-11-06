import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BLF-1441 · 账号管理页的显示名口径（#778 收口后）。
 *
 * 1. 「姓名」列只显示 `full_name`；为空时显示「未命名」，**不**回落登录名。
 * 2. 「运营名」列与编辑框已删除（`operator_name_zh` 随后端 #778 移除），
 *    表格里不应再出现这一列，PATCH / POST 也不再携带这个键。
 * 3. 编辑弹窗只剩「姓名」「角色属性」；新增账号仍必填姓名。
 */

const { NOTIFY, SESSION } = vi.hoisted(() => ({
  NOTIFY: { notify: vi.fn() },
  SESSION: {
    user: { id: 'admin-1', roleType: 'admin', fullName: '纪亚伟', isAdmin: true },
  },
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: SESSION, status: 'authenticated' }),
}))

vi.mock('@/components/notifications', () => ({
  useNotifications: () => NOTIFY,
}))

vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
}))

import AccountManagementPage from './page'

const USERS = {
  items: [
    {
      id: 'u1',
      name: 'Yawei',
      email: 'yawei@believeboy.com',
      fullName: '纪亚伟',
      isActive: true,
      roleType: 'admin',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-08-01T00:00:00Z',
    },
    {
      id: 'u2',
      name: 'DamonROCK',
      email: 'rock@believeboy.com',
      // 账号存在但没填姓名：应显示「未命名」，不是 DamonROCK。
      fullName: null,
      isActive: true,
      roleType: 'operator',
      createdAt: '2026-01-02T00:00:00Z',
      updatedAt: '2026-08-02T00:00:00Z',
    },
    {
      id: 'u3',
      name: 'Leo',
      email: 'leo@believeboy.com',
      fullName: '朱凤建',
      isActive: true,
      roleType: 'admin',
      createdAt: '2026-01-03T00:00:00Z',
      updatedAt: '2026-08-03T00:00:00Z',
    },
  ],
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

let fetchMock: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  NOTIFY.notify.mockReset()
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === '/api/admin/users' && (!init || !init.method || init.method === 'GET')) {
      return jsonResponse(USERS)
    }
    if (url.startsWith('/api/admin/users/') && init?.method === 'PATCH') {
      const id = url.split('/').pop()!
      const patch = JSON.parse(String(init.body)) as Record<string, unknown>
      const base = USERS.items.find((item) => item.id === id)!
      return jsonResponse({
        item: {
          ...base,
          fullName: 'fullName' in patch ? (patch.fullName as string | null) : base.fullName,
          isActive: 'isActive' in patch ? (patch.isActive as boolean) : base.isActive,
          roleType: 'roleType' in patch ? patch.roleType : base.roleType,
        },
      })
    }
    if (url.startsWith('/api/admin/users/') && init?.method === 'DELETE') {
      return jsonResponse({ ok: true })
    }
    return jsonResponse({}, 404)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function renderPage() {
  const result = render(<AccountManagementPage />)
  // V4 仅保留桌面表格，等待表头确认数据已完成首轮加载。
  await screen.findByRole('columnheader', { name: '姓名' })
  return result
}

/** Warm 表格里按「名称」列（登录名）定位一行。 */
function desktopRow(loginName: string): HTMLElement {
  const table = screen.getByRole('table')
  const nameCell = within(table).getByText(loginName, { selector: 'td' })
  return nameCell.closest('tr') as HTMLElement
}

/** 行内第 n 个单元格的文本（0 = 名称）。 */
function cellText(row: HTMLElement, index: number): string {
  return row.querySelectorAll('td')[index]?.textContent?.trim() ?? ''
}

describe('账号管理 · 姓名列只取 full_name', () => {
  it('full_name 有值 → 姓名列显示姓名', async () => {
    await renderPage()

    const row = desktopRow('Yawei')
    // 姓名列 = 第 2 格
    expect(cellText(row, 1)).toBe('纪亚伟')
  })

  it('full_name 为空 → 姓名列显示「未命名」，不回落登录名', async () => {
    await renderPage()

    const row = desktopRow('DamonROCK')
    expect(cellText(row, 1)).toBe('未命名')
    // 登录名只出现在「名称」列，绝不冒充姓名
    expect(cellText(row, 0)).toBe('DamonROCK')
  })

  it('「运营名」列已删除：表头只有姓名、没有运营名', async () => {
    await renderPage()

    const headers = within(screen.getByRole('table'))
      .getAllByRole('columnheader')
      .map((el) => el.textContent)
    expect(headers).toContain('姓名')
    expect(headers).not.toContain('运营名')
  })

  it('删列后姓名的下一格是邮箱（列序收紧）', async () => {
    await renderPage()

    const row = desktopRow('Leo')
    expect(cellText(row, 1)).toBe('朱凤建')
    expect(cellText(row, 2)).toBe('leo@believeboy.com')
  })
})

describe('账号管理 · 编辑弹窗（只剩姓名 / 角色属性）', () => {
  async function openEditFor(loginName: string) {
    await renderPage()
    const row = desktopRow(loginName)
    await userEvent.click(within(row).getByRole('button', { name: '更多操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /编辑/ }))
    return screen.findByRole('dialog')
  }

  it('姓名回填 full_name 列；弹窗里没有「运营名」输入框', async () => {
    const dialog = await openEditFor('Yawei')

    expect(within(dialog).getByLabelText('姓名')).toHaveValue('纪亚伟')
    expect(within(dialog).queryByLabelText('运营名')).toBeNull()
  })

  it('full_name 为空时姓名框为空', async () => {
    const dialog = await openEditFor('DamonROCK')

    expect(within(dialog).getByLabelText('姓名')).toHaveValue('')
  })

  it('保存时只提交 fullName，不再携带 operator_name_zh', async () => {
    const dialog = await openEditFor('DamonROCK')

    const fullNameInput = within(dialog).getByLabelText('姓名')
    await userEvent.clear(fullNameInput)
    await userEvent.type(fullNameInput, '临时账号')

    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (call: unknown[]) =>
          String(call[0]) === '/api/admin/users/u2' &&
          (call[1] as RequestInit | undefined)?.method === 'PATCH'
      )
      expect(patchCall).toBeTruthy()
      const body = JSON.parse(String((patchCall![1] as RequestInit).body))
      expect(body.fullName).toBe('临时账号')
      expect(body).not.toHaveProperty('operator_name_zh')
      // 路由层读 camelCase `roleType`；发 snake_case 会被静默丢弃（旧 bug）。
      expect(body.roleType).toBe('operator')
      expect(body).not.toHaveProperty('role_type')
    })
  })

  it('清空姓名时提交空串（交给后端落 null）', async () => {
    const dialog = await openEditFor('Yawei')

    await userEvent.clear(within(dialog).getByLabelText('姓名'))
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (call: unknown[]) =>
          String(call[0]) === '/api/admin/users/u1' &&
          (call[1] as RequestInit | undefined)?.method === 'PATCH'
      )
      expect(patchCall).toBeTruthy()
      const body = JSON.parse(String((patchCall![1] as RequestInit).body))
      expect(body.fullName).toBe('')
      expect(body).not.toHaveProperty('operator_name_zh')
    })
  })

  it('编辑角色属性时提交 camelCase roleType', async () => {
    const dialog = await openEditFor('DamonROCK')

    await userEvent.selectOptions(within(dialog).getByLabelText('角色属性'), 'businessdev')
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (call: unknown[]) =>
          String(call[0]) === '/api/admin/users/u2' &&
          (call[1] as RequestInit | undefined)?.method === 'PATCH'
      )
      expect(patchCall).toBeTruthy()
      const body = JSON.parse(String((patchCall![1] as RequestInit).body))
      expect(body.roleType).toBe('businessdev')
      expect(body).not.toHaveProperty('role_type')
    })
  })
})

describe('账号管理 · Warm Ledger 与既有写入行为', () => {
  it('使用 Warm 本地页面表面，不渲染 Terminal 视觉类', async () => {
    const { container } = await renderPage()
    const page = container.querySelector('[data-warm-account-management="true"]')

    expect(page).toBeTruthy()
    expect(container.querySelector('[class*="term-"]')).toBeNull()
    expect(container.querySelector('.rounded-none')).toBeNull()
    expect(screen.getAllByRole('table')).toHaveLength(1)
  })

  it('刷新中只显示一个 loading mark，完成后恢复刷新图标', async () => {
    const user = userEvent.setup()
    await renderPage()

    let resolveRefresh: (response: Response) => void = () => {}
    const pendingRefresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve
    })
    fetchMock.mockImplementationOnce(() => pendingRefresh)

    await user.click(screen.getByRole('button', { name: '刷新' }))
    const refreshingButton = await screen.findByRole('button', { name: '正在刷新账号列表' })

    expect(refreshingButton).toHaveAttribute('aria-busy', 'true')
    expect(refreshingButton.querySelectorAll('.warm-ledger__loading-mark')).toHaveLength(1)
    expect(refreshingButton.querySelector('svg')).not.toBeInTheDocument()
    expect(refreshingButton).toHaveTextContent('刷新中')

    resolveRefresh(jsonResponse(USERS))
    await waitFor(() => expect(refreshingButton).not.toHaveAttribute('aria-busy'))
    expect(refreshingButton.querySelector('.warm-ledger__loading-mark')).not.toBeInTheDocument()
    expect(refreshingButton.querySelector('svg')).toBeInTheDocument()
    expect(refreshingButton).toHaveTextContent('刷新')
  })

  it('账号弹窗同样使用 Warm 控件，不混入 Terminal 类', async () => {
    await renderPage()
    await userEvent.click(screen.getByRole('button', { name: '新增账号' }))
    const dialog = await screen.findByRole('dialog')

    expect(dialog.querySelectorAll('[class*="term-"]')).toHaveLength(0)
    expect(dialog.querySelectorAll('.rounded-none')).toHaveLength(0)
  })

  it('启停按钮保留 PATCH 契约', async () => {
    await renderPage()
    const row = desktopRow('DamonROCK')

    await userEvent.click(within(row).getByRole('button', { name: '停用' }))

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (call: unknown[]) =>
          String(call[0]) === '/api/admin/users/u2' &&
          (call[1] as RequestInit | undefined)?.method === 'PATCH'
      )
      expect(patchCall).toBeTruthy()
      expect(JSON.parse(String((patchCall![1] as RequestInit).body))).toEqual({
        isActive: false,
      })
    })
  })

  it('重置密码保留 PATCH password 契约', async () => {
    await renderPage()
    const row = desktopRow('DamonROCK')

    await userEvent.click(within(row).getByRole('button', { name: '更多操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '重置密码' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.type(within(dialog).getByLabelText('新密码'), 'new-password')
    await userEvent.click(within(dialog).getByRole('button', { name: '确认重置' }))

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (call: unknown[]) =>
          String(call[0]) === '/api/admin/users/u2' &&
          (call[1] as RequestInit | undefined)?.method === 'PATCH' &&
          JSON.parse(String((call[1] as RequestInit).body)).password === 'new-password'
      )
      expect(patchCall).toBeTruthy()
    })
  })

  it('删除账号保留 DELETE 契约和确认弹窗', async () => {
    await renderPage()
    const row = desktopRow('DamonROCK')

    await userEvent.click(within(row).getByRole('button', { name: '更多操作' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: '删除账号' }))
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/admin/users/u2', { method: 'DELETE' })
    })
  })
})

describe('账号管理 · 新增账号要求填写姓名', () => {
  async function openCreate() {
    await renderPage()
    await userEvent.click(screen.getByRole('button', { name: '新增账号' }))
    return screen.findByRole('dialog')
  }

  it('姓名字段是必填项', async () => {
    const dialog = await openCreate()

    expect(within(dialog).getByLabelText('姓名')).toBeRequired()
  })

  it('创建时把姓名作为 fullName 提交', async () => {
    const dialog = await openCreate()

    await userEvent.type(within(dialog).getByLabelText('名称'), 'newbie')
    await userEvent.type(within(dialog).getByLabelText('姓名'), '新同事')
    await userEvent.type(within(dialog).getByLabelText('邮箱'), 'newbie@believeboy.com')
    await userEvent.type(within(dialog).getByLabelText('初始密码'), 'password123')

    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({
        item: {
          id: 'u9',
          name: 'newbie',
          email: 'newbie@believeboy.com',
          fullName: '新同事',
          isActive: true,
          roleType: 'operator',
          createdAt: '2026-10-24T00:00:00Z',
          updatedAt: '2026-10-24T00:00:00Z',
        },
      })
    )

    await userEvent.click(within(dialog).getByRole('button', { name: '创建账号' }))

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (call: unknown[]) => String(call[0]) === '/api/admin/users' && (call[1] as RequestInit)?.method === 'POST'
      )
      expect(postCall).toBeTruthy()
      const body = JSON.parse(String((postCall![1] as RequestInit).body))
      expect(body.fullName).toBe('新同事')
      expect(body).not.toHaveProperty('operator_name_zh')
    })
  })

  it('姓名全是空白字符时拒绝提交（HTML required 挡不住空格）', async () => {
    const dialog = await openCreate()

    await userEvent.type(within(dialog).getByLabelText('名称'), 'newbie')
    await userEvent.type(within(dialog).getByLabelText('姓名'), '   ')
    await userEvent.type(within(dialog).getByLabelText('邮箱'), 'newbie@believeboy.com')
    await userEvent.type(within(dialog).getByLabelText('初始密码'), 'password123')

    await userEvent.click(within(dialog).getByRole('button', { name: '创建账号' }))

    await waitFor(() => {
      expect(NOTIFY.notify).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', title: '请填写姓名' })
      )
    })
    const postCall = fetchMock.mock.calls.find(
      (call: unknown[]) =>
        String(call[0]) === '/api/admin/users' &&
        (call[1] as RequestInit | undefined)?.method === 'POST'
    )
    expect(postCall).toBeUndefined()
    // 弹窗保持打开，用户可以直接补名字，不用重新填其他字段。
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('提交前把姓名两端空格 trim 掉', async () => {
    const dialog = await openCreate()

    await userEvent.type(within(dialog).getByLabelText('名称'), 'newbie')
    await userEvent.type(within(dialog).getByLabelText('姓名'), '  新同事  ')
    await userEvent.type(within(dialog).getByLabelText('邮箱'), 'newbie@believeboy.com')
    await userEvent.type(within(dialog).getByLabelText('初始密码'), 'password123')

    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({
        item: {
          id: 'u9',
          name: 'newbie',
          email: 'newbie@believeboy.com',
          fullName: '新同事',
          isActive: true,
          roleType: 'operator',
          createdAt: '2026-10-24T00:00:00Z',
          updatedAt: '2026-10-24T00:00:00Z',
        },
      })
    )

    await userEvent.click(within(dialog).getByRole('button', { name: '创建账号' }))

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (call: unknown[]) =>
          String(call[0]) === '/api/admin/users' &&
          (call[1] as RequestInit | undefined)?.method === 'POST'
      )
      expect(postCall).toBeTruthy()
      const body = JSON.parse(String((postCall![1] as RequestInit).body))
      expect(body.fullName).toBe('新同事')
    })
  })
})
