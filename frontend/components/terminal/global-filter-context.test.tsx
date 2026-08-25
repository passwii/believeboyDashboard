import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import {
  GLOBAL_FILTER_URL_KEYS,
  TerminalGlobalFilterProvider,
  defaultGlobalDateRange,
  isGlobalFilterPilotRoute,
  useTerminalGlobalFilter,
} from './global-filter-context'

// router.replace 只需可调用，不真导航
const replaceMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => '/dashboard/operations/daily-analysis',
}))

/** 探针：把 context 当前值渲染到 DOM，供断言 */
function Probe() {
  const ctx = useTerminalGlobalFilter()
  return (
    <div>
      <span data-testid="ready">{String(ctx.ready)}</span>
      <span data-testid="project">{ctx.projectId}</span>
      <span data-testid="country">{ctx.country}</span>
      <span data-testid="date">{`${ctx.dateFrom}~${ctx.dateTo}`}</span>
      <button type="button" onClick={() => ctx.setProjectId('42')}>
        set-project
      </button>
      <button type="button" onClick={() => ctx.setCountry('DE')}>
        set-country
      </button>
      <button type="button" onClick={() => ctx.setDateRange('2026-08-01', '2026-08-07')}>
        set-range
      </button>
    </div>
  )
}

function renderProvider() {
  return render(
    <TerminalGlobalFilterProvider>
      <Probe />
    </TerminalGlobalFilterProvider>
  )
}

beforeEach(() => {
  window.localStorage.clear()
  window.history.replaceState(null, '', '/dashboard')
  replaceMock.mockReset()
})

afterEach(() => {
  window.localStorage.clear()
})

describe('global-filter-context', () => {
  it('默认值水合：无 URL 无 storage 时 country=US、日期=近7天', async () => {
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    expect(screen.getByTestId('project')).toHaveTextContent('')
    expect(screen.getByTestId('country')).toHaveTextContent('US')
    const def = defaultGlobalDateRange()
    expect(screen.getByTestId('date')).toHaveTextContent(`${def.dateFrom}~${def.dateTo}`)
  })

  it('URL g* 参数优先于 localStorage 与默认值', async () => {
    window.localStorage.setItem(
      'bb.terminal.global-filter',
      JSON.stringify({ projectId: '1', country: 'UK', dateFrom: '2026-07-01', dateTo: '2026-07-07' })
    )
    window.history.replaceState(
      null,
      '',
      '/dashboard?gProject=99&gCountry=DE&gDateFrom=2026-08-01&gDateTo=2026-08-05'
    )
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    expect(screen.getByTestId('project')).toHaveTextContent('99')
    expect(screen.getByTestId('country')).toHaveTextContent('DE')
    expect(screen.getByTestId('date')).toHaveTextContent('2026-08-01~2026-08-05')
  })

  it('setProjectId 写 localStorage + URL（router.replace 携带 gProject）', async () => {
    const user = userEvent.setup()
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    await user.click(screen.getByRole('button', { name: 'set-project' }))
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem('bb.terminal.global-filter')!)).toMatchObject({
        projectId: '42',
      })
    )
    expect(replaceMock).toHaveBeenCalledTimes(1)
    const [href] = replaceMock.mock.calls[0] as unknown as [string]
    expect(href).toContain(`${GLOBAL_FILTER_URL_KEYS.projectId}=42`)
  })

  it('setDateRange 同时落 from/to 到 storage 与 URL', async () => {
    const user = userEvent.setup()
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    await user.click(screen.getByRole('button', { name: 'set-range' }))
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem('bb.terminal.global-filter')!)
      ).toMatchObject({ dateFrom: '2026-08-01', dateTo: '2026-08-07' })
    )
    const [href] = replaceMock.mock.calls[0] as unknown as [string]
    expect(href).toContain('gDateFrom=2026-08-01')
    expect(href).toContain('gDateTo=2026-08-07')
  })

  it('localStorage 记忆：二次进入（无 URL 参数）恢复上次选择', async () => {
    // 第一次进入写入
    const user = userEvent.setup()
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))
    await user.click(screen.getByRole('button', { name: 'set-country' }))
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem('bb.terminal.global-filter')!)
      ).toMatchObject({ country: 'DE' })
    )
    // 卸载后二次进入
    renderProvider()
    await waitFor(() => expect(screen.getAllByTestId('country')[1]).toHaveTextContent('DE'))
  })
})

describe('isGlobalFilterPilotRoute', () => {
  it('试点路由命中（销售数据 + 订单信息），其余页面不激活', () => {
    expect(isGlobalFilterPilotRoute('/dashboard/operations/daily-analysis')).toBe(true)
    expect(isGlobalFilterPilotRoute('/dashboard/reports/order-info')).toBe(true)
    expect(isGlobalFilterPilotRoute('/dashboard/reports/order-info/sub')).toBe(true)
    expect(isGlobalFilterPilotRoute('/dashboard/advertising/ad-analysis/overview')).toBe(false)
    expect(isGlobalFilterPilotRoute('/dashboard')).toBe(false)
  })
})
