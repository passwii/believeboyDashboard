import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import GenerateTab from './generate-client'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'
import { readSharedReportProjectId, writeSharedReportProjectId } from '../shared-project'

import { stableSession } from '@/test-utils/stable-mocks'

// ── next/navigation：可控的 URL search param 存储 ────────────────────────────
// useUrlParam 从 useSearchParams 读、经 router.replace 写。这里用一个进程内
// URLSearchParams 模拟"已落定的 URL"（project/country/month 都有值）。
const nav = vi.hoisted(() => {
  let params = new URLSearchParams('project=铨富&country=US&month=2026-07')
  return {
    setParams(qs: string) {
      params = new URLSearchParams(qs)
    },
    get: (key: string) => params.get(key),
    toString: () => params.toString(),
    replace: (url: string) => {
      const qs = url.includes('?') ? (url.split('?')[1] ?? '') : ''
      params = new URLSearchParams(qs)
    },
  }
})

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: nav.get, toString: nav.toString }),
  usePathname: () => '/dashboard/reports/monthly-report/generate',
  useRouter: () => ({ replace: nav.replace, push: nav.replace }),
}))

// 共享记忆按操作者身份隔离：这个身份就是测试里读写记忆用的身份
const TEST_OWNER = { id: 'user-1', roleType: 'admin', name: '张三', isAdmin: true }
vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: TEST_OWNER }),
}))

vi.mock('@/lib/project-client-cache', () => ({
  fetchManagedProjectsCached: vi.fn(),
}))

// ── BLF-963 · head 插槽 mock：捕获插槽节点 / 移动端筛选条节点 ───────────────
//（display-client.test.tsx:49-67 同模式；本页无刷新语义，不注册 useHeaderRefresh）
const headerCapture = vi.hoisted(() => ({
  slotNode: null as ReactNode,
  mobileNode: null as ReactNode,
}))
vi.mock('@/components/terminal/terminal-header-slot', () => ({
  useHeaderRefresh: () => ({ setLoading: vi.fn() }),
  useHeaderSlot: (node: ReactNode) => {
    headerCapture.slotNode = node
    return null
  },
  useMobileFilterStrip: (node: ReactNode) => {
    headerCapture.mobileNode = node
    return null
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  headerCapture.slotNode = null
  headerCapture.mobileNode = null
  ;(fetchManagedProjectsCached as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: 1, name: '铨富' },
    { id: 2, name: '玥涵' },
  ])
  nav.setParams('project=铨富&country=US&month=2026-07')
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BLF-963 头部插槽契约', () => {
  it('正文不再渲染项目/国家/月份筛选，slotNode 内三控件齐全', async () => {
    render(<GenerateTab />)
    // 正文控制台保留状态 tiles
    await screen.findByText('文件识别与上传')
    expect(headerCapture.slotNode).not.toBeNull()

    // 正文（插槽 mock 不渲染 portal 内容）不应出现筛选控件与旧控制台文案
    expect(screen.queryByText('项目名称')).not.toBeInTheDocument()
    expect(screen.queryByText('国家站点')).not.toBeInTheDocument()
    expect(screen.queryByText('账期月份')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('请选择项目名称')).not.toBeInTheDocument()

    // 状态 tiles 保留在正文（文件识别与上传卡片内亦有"上传"按钮，用 getAllByText 断言存在即可）
    expect(screen.getByText('识别')).toBeInTheDocument()
    expect(screen.getAllByText('上传').length).toBeGreaterThan(0)
    expect(screen.getByText('表格生成')).toBeInTheDocument()

    // 单独渲染插槽节点：项目 / 国家 / 账期月份 3 个控件确实都在插槽内容里
    //（已选中具体值时渲染选中文本而非 placeholder：项目=铨富、国家=美国站、月份=2026年7月）
    render(<>{headerCapture.slotNode}</>)
    expect(await screen.findByText('铨富')).toBeInTheDocument()
    expect(screen.getByText('美国站 (US)')).toBeInTheDocument()
    expect(screen.getByText('2026年7月')).toBeInTheDocument()
  })

  it('移动端筛选条注册成功且摘要包含当前筛选', async () => {
    render(<GenerateTab />)
    await screen.findByText('文件识别与上传')
    expect(headerCapture.mobileNode).not.toBeNull()

    render(<>{headerCapture.mobileNode}</>)
    expect(await screen.findByText(/铨富.*美国站.*2026-07/)).toBeInTheDocument()
  })
})

describe('BLF-1344 项目选择跨 tab 共享', () => {
  it('URL 没带项目时按共享记忆里的项目 id 选中同名项目，并写回 URL', async () => {
    // 上一次在月报某个 tab 选过项目 2（共享记忆存项目 id）
    writeSharedReportProjectId(TEST_OWNER, '2')
    nav.setParams('country=US&month=2026-07')

    render(<GenerateTab />)
    await screen.findByText('文件识别与上传')

    // 本页 URL / 接口历来用项目名称：采用共享记忆后应落成对应名称
    //（测试 mock 的 router.replace 不会触发重渲染，所以断言落在 URL 而不是渲染结果上）
    await waitFor(() => expect(new URLSearchParams(nav.toString()).get('project')).toBe('玥涵'))
  })

  it('URL 指定项目名时把对应项目 id 写回共享记忆', async () => {
    nav.setParams('project=玥涵&country=US&month=2026-07')

    render(<GenerateTab />)
    await screen.findByText('文件识别与上传')

    await waitFor(() => expect(readSharedReportProjectId(TEST_OWNER)).toBe('2'))
  })

  it('共享记忆里的项目不在本页项目列表时保持未选，不静默选错项目', async () => {
    writeSharedReportProjectId(TEST_OWNER, '999')
    nav.setParams('country=US&month=2026-07')

    render(<GenerateTab />)
    await screen.findByText('文件识别与上传')

    await waitFor(() => expect(headerCapture.slotNode).not.toBeNull())
    expect(new URLSearchParams(nav.toString()).get('project')).toBeNull()
    expect(readSharedReportProjectId(TEST_OWNER)).toBe('999')
  })
})
