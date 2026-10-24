import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BLF-1441 · 账号管理页的显示名口径。
 *
 * 1. 「姓名」列只显示 `full_name`；为空时显示「未命名」，**不**回落运营名
 *    （旧实现是 `fullName || operatorNameZh || '-'`，正是新口径禁止的兜底）。
 * 2. 「运营名」独立成列，避免两个语义不同的字段挤在一格里。
 * 3. 编辑弹窗拆成「姓名」「运营名」两栏，分别回填各自的列；保存时两个字段
 *    各自 PATCH，不再「回填姓名、只写运营名」。
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
      operatorNameZh: '纪亚伟',
      isActive: true,
      roleType: 'admin',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-08-01T00:00:00Z',
    },
    {
      id: 'u2',
      name: 'DamonROCK',
      email: 'rock@believeboy.com',
      // 账号存在但没填姓名：应显示「未命名」，不是 DamonROCK 也不是运营名。
      fullName: null,
      operatorNameZh: '临时运营',
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
      operatorNameZh: null,
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
          operatorNameZh:
            'operator_name_zh' in patch
              ? (patch.operator_name_zh as string | null)
              : base.operatorNameZh,
        },
      })
    }
    return jsonResponse({}, 404)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function renderPage() {
  render(<AccountManagementPage />)
  // 桌面表格 + 手机卡片两处都会渲染，按表头等待（唯一）。
  await screen.findByRole('columnheader', { name: '运营名' })
}

/** 桌面表格（md:block 分支）里按「名称」列（登录名）定位一行。 */
function desktopRow(loginName: string): HTMLElement {
  const desktop = document.querySelector('.hidden.md\\:block') as HTMLElement
  const nameCell = within(desktop).getByText(loginName, { selector: 'td' })
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
    // 姓名列 = 第 2 格；运营名列 = 第 3 格（两列都叫「纪亚伟」时也要能分清）
    expect(cellText(row, 1)).toBe('纪亚伟')
    expect(cellText(row, 2)).toBe('纪亚伟')
  })

  it('full_name 为空 → 姓名列显示「未命名」，不回落运营名与登录名', async () => {
    await renderPage()

    const row = desktopRow('DamonROCK')
    expect(cellText(row, 1)).toBe('未命名')
    // 运营名单独一列，不再被当成姓名显示
    expect(cellText(row, 2)).toBe('临时运营')
    // 登录名只出现在「名称」列，绝不冒充姓名
    expect(cellText(row, 0)).toBe('DamonROCK')
  })

  it('运营名独立成列（表头存在）', async () => {
    await renderPage()

    const desktop = document.querySelector('.hidden.md\\:block') as HTMLElement
    const headers = within(desktop).getAllByRole('columnheader').map((el) => el.textContent)
    expect(headers).toContain('姓名')
    expect(headers).toContain('运营名')
  })

  it('运营名为空时显示占位符，不与姓名混淆', async () => {
    await renderPage()

    const row = desktopRow('朱凤建')
    expect(cellText(row, 1)).toBe('朱凤建')
    expect(cellText(row, 2)).toBe('-')
  })
})

describe('账号管理 · 编辑弹窗拆两栏', () => {
  async function openEditFor(loginName: string) {
    await renderPage()
    const desktop = document.querySelector('.hidden.md\\:block') as HTMLElement
    const row = within(desktop).getByText(loginName).closest('tr') as HTMLElement
    await userEvent.click(within(row).getByRole('button', { name: '' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: /编辑/ }))
    return screen.findByRole('dialog')
  }

  it('姓名与运营名各自回填各自的列', async () => {
    const dialog = await openEditFor('Yawei')

    expect(within(dialog).getByLabelText('姓名')).toHaveValue('纪亚伟')
    expect(within(dialog).getByLabelText('运营名')).toHaveValue('纪亚伟')
  })

  it('full_name 为空时姓名框为空，不拿运营名填进去', async () => {
    const dialog = await openEditFor('DamonROCK')

    expect(within(dialog).getByLabelText('姓名')).toHaveValue('')
    expect(within(dialog).getByLabelText('运营名')).toHaveValue('临时运营')
  })

  it('保存时两个字段分别提交（fullName + operator_name_zh）', async () => {
    const dialog = await openEditFor('DamonROCK')

    const fullNameInput = within(dialog).getByLabelText('姓名')
    await userEvent.clear(fullNameInput)
    await userEvent.type(fullNameInput, '临时账号')
    const operatorInput = within(dialog).getByLabelText('运营名')
    await userEvent.clear(operatorInput)
    await userEvent.type(operatorInput, '临时运营2')

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
      expect(body.operator_name_zh).toBe('临时运营2')
      // 路由层读 camelCase `roleType`；发 snake_case 会被静默丢弃（旧 bug）。
      expect(body.roleType).toBe('operator')
      expect(body).not.toHaveProperty('role_type')
    })
  })

  it('清空姓名时提交空串（交给后端落 null），不回落运营名', async () => {
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
      expect(body.operator_name_zh).toBe('纪亚伟')
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

  it('创建时把姓名作为 fullName 提交（不是运营名）', async () => {
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
          operatorNameZh: null,
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
          operatorNameZh: null,
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
