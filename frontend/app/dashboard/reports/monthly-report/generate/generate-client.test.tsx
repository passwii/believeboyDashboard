import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'

import GenerateTab from './generate-client'
import { fetchManagedProjectsCached } from '@/lib/project-client-cache'

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

vi.mock('next-auth/react', () => ({
  useSession: () => stableSession({ user: { isAdmin: true } }),
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
