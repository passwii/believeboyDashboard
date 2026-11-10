import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replaced: [] as string[],
  setUrl(hasQuery: string) {
    this.params = new URLSearchParams(hasQuery)
    this.replaced = []
  },
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.params,
  usePathname: () => '/dashboard/crm/intent',
  useRouter: () => ({
    replace: (url: string) => {
      nav.replaced.push(String(url))
      nav.params = new URLSearchParams(String(url).split('?')[1] ?? '')
    },
    push: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
}))

import { readIntentState, useIntentFilters } from './use-intent-filters'

function Probe() {
  const { state, patch, resetFilters, openRecord } = useIntentFilters()
  return (
    <div>
      <span data-testid="state">{JSON.stringify(state)}</span>
      <button onClick={() => patch({ level: 'B' })} type="button">
        set-level-b
      </button>
      <button onClick={() => patch({ page: 3 })} type="button">
        set-page-3
      </button>
      <button onClick={() => patch({ province: '浙江' })} type="button">
        set-province
      </button>
      <button onClick={() => patch({ record: 5 })} type="button">
        open-record
      </button>
      <button onClick={() => openRecord(null)} type="button">
        close-record
      </button>
      <button onClick={resetFilters} type="button">
        reset
      </button>
    </div>
  )
}

function currentState() {
  return JSON.parse(screen.getByTestId('state').textContent ?? '{}') as Record<string, unknown>
}

beforeEach(() => {
  nav.setUrl('')
})

describe('readIntentState', () => {
  it('从 URL 读取全部筛选，非法枚举值回退默认', () => {
    const state = readIntentState(
      new URLSearchParams(
        'tab=pool&scope=all&q=测试&level=A&category=家居用品&channel=展会&province=浙江&city=宁波&state=won&sort=name&with_phone=1&dup=1&due=1&group=1&view=table&page=2&pool_q=池&pool_page=3&record=5'
      )
    )
    expect(state).toMatchObject({
      tab: 'pool',
      scope: 'all',
      q: '测试',
      level: 'A',
      category: '家居用品',
      channel: '展会',
      province: '浙江',
      city: '宁波',
      state: 'won',
      sort: 'name',
      withPhone: true,
      dup: true,
      due: true,
      group: true,
      view: 'table',
      page: 2,
      poolQ: '池',
      poolPage: 3,
      record: 5,
    })

    const fallback = readIntentState(new URLSearchParams('tab=oops&scope=x&level=Z&state=bad&view=xx&page=-1'))
    expect(fallback.tab).toBe('intent')
    expect(fallback.scope).toBe('mine')
    expect(fallback.level).toBeNull()
    expect(fallback.state).toBeNull()
    expect(fallback.view).toBe('card')
    expect(fallback.page).toBe(1)
  })
})

describe('useIntentFilters', () => {
  it('默认值不写 URL；patch 写 URL 且筛选变更回到第 1 页', async () => {
    render(<Probe />)
    expect(currentState()).toMatchObject({ tab: 'intent', scope: 'mine', level: null, page: 1 })

    fireEvent.click(screen.getByText('set-page-3'))
    await waitFor(() => expect(currentState().page).toBe(3))
    expect(nav.replaced.at(-1)).toContain('page=3')

    fireEvent.click(screen.getByText('set-level-b'))
    await waitFor(() => expect(currentState()).toMatchObject({ level: 'B', page: 1 }))
    const lastUrl = nav.replaced.at(-1) ?? ''
    expect(lastUrl).toContain('level=B')
    expect(lastUrl).not.toContain('page=3')
  })

  it('省份变更清空城市；record 参数可打开/关闭深链', async () => {
    nav.setUrl('city=宁波')
    render(<Probe />)
    expect(currentState().city).toBe('宁波')

    fireEvent.click(screen.getByText('set-province'))
    await waitFor(() => expect(currentState()).toMatchObject({ province: '浙江', city: null }))

    fireEvent.click(screen.getByText('open-record'))
    await waitFor(() => expect(currentState().record).toBe(5))
    expect(nav.replaced.at(-1)).toContain('record=5')

    fireEvent.click(screen.getByText('close-record'))
    await waitFor(() => expect(currentState().record).toBeNull())
    expect(nav.replaced.at(-1)).not.toContain('record=')
  })

  it('resetFilters 清空筛选但保留 tab/scope', async () => {
    nav.setUrl('tab=pool&scope=all&level=A&q=关键词&duplicate=1&record=5')
    render(<Probe />)
    fireEvent.click(screen.getByText('reset'))
    await waitFor(() => expect(currentState()).toMatchObject({
      tab: 'pool',
      scope: 'all',
      level: null,
      q: '',
      page: 1,
    }))
    expect(currentState().record).toBe(5)
  })
})
