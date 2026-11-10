'use client'

/**
 * 意向客户 URL 筛选状态（单一真理源）。
 *
 * 设计稿 §8.4：筛选 / tab / scope / page 全部进 URL（刷新可恢复），
 * 抽屉用 ?record=<id> 深链。默认值不进 URL，保持地址可读。
 *
 * 实现说明：URL 是权威来源；本地 mirror 只是为了让 router.replace 后
 * 当前渲染立即拿到新值（浏览器前进/后退时再由 effect 从 URL 同步）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import {
  INTENT_LEVEL_ORDER,
  INTENT_SCOPE_ORDER,
  INTENT_SORT_ORDER,
  INTENT_STATE_ORDER,
  INTENT_TAB_ORDER,
  INTENT_VIEW_ORDER,
  INTENT_PAGE_SIZE,
  INTENT_POOL_PAGE_SIZE,
  type IntentLevel,
  type IntentScope,
  type IntentSort,
  type IntentState,
  type IntentTab,
  type IntentView,
} from './types'

export const DEFAULT_INTENT_STATE: IntentQueryState = {
  tab: 'intent',
  scope: 'mine',
  q: '',
  level: null,
  category: null,
  channel: null,
  province: null,
  city: null,
  state: null,
  sort: 'score',
  withPhone: false,
  dup: false,
  due: false,
  group: false,
  view: 'card',
  page: 1,
  poolQ: '',
  poolPage: 1,
  record: null,
}

export interface IntentQueryState {
  tab: IntentTab
  scope: IntentScope
  q: string
  level: IntentLevel | null
  category: string | null
  channel: string | null
  province: string | null
  city: string | null
  state: IntentState | null
  sort: IntentSort
  withPhone: boolean
  dup: boolean
  due: boolean
  group: boolean
  view: IntentView
  page: number
  poolQ: string
  poolPage: number
  record: number | null
}

function pickEnum<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T
): T {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function pickOptionalEnum<T extends string>(
  value: string | null,
  allowed: readonly T[]
): T | null {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

function pickText(value: string | null): string {
  return value ?? ''
}

function pickFlag(params: URLSearchParams, key: string): boolean {
  return params.get(key) === '1' || params.get(key) === 'true'
}

function pickPositiveInt(value: string | null, fallback: number): number {
  const parsed = value === null ? NaN : Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** 从 URLSearchParams 读取筛选状态（非法值回退默认）。 */
export function readIntentState(params: URLSearchParams): IntentQueryState {
  const recordRaw = params.get('record')
  const recordId = recordRaw === null ? NaN : Number(recordRaw)
  return {
    tab: pickEnum(params.get('tab'), INTENT_TAB_ORDER, DEFAULT_INTENT_STATE.tab),
    scope: pickEnum(params.get('scope'), INTENT_SCOPE_ORDER, DEFAULT_INTENT_STATE.scope),
    q: pickText(params.get('q')),
    level: pickOptionalEnum(params.get('level'), INTENT_LEVEL_ORDER),
    category: params.get('category'),
    channel: params.get('channel'),
    province: params.get('province'),
    city: params.get('city'),
    state: pickOptionalEnum(params.get('state'), INTENT_STATE_ORDER),
    sort: pickEnum(params.get('sort'), INTENT_SORT_ORDER, DEFAULT_INTENT_STATE.sort),
    withPhone: pickFlag(params, 'with_phone'),
    dup: pickFlag(params, 'dup'),
    due: pickFlag(params, 'due'),
    group: pickFlag(params, 'group'),
    view: pickEnum(params.get('view'), INTENT_VIEW_ORDER, DEFAULT_INTENT_STATE.view),
    page: pickPositiveInt(params.get('page'), 1),
    poolQ: pickText(params.get('pool_q')),
    poolPage: pickPositiveInt(params.get('pool_page'), 1),
    record: Number.isInteger(recordId) && recordId > 0 ? recordId : null,
  }
}

/** 把筛选状态写回 URLSearchParams；默认值省略。 */
export function buildIntentSearchParams(state: IntentQueryState): URLSearchParams {
  const params = new URLSearchParams()
  if (state.tab !== DEFAULT_INTENT_STATE.tab) params.set('tab', state.tab)
  if (state.scope !== DEFAULT_INTENT_STATE.scope) params.set('scope', state.scope)
  if (state.q.trim()) params.set('q', state.q.trim())
  if (state.level) params.set('level', state.level)
  if (state.category) params.set('category', state.category)
  if (state.channel) params.set('channel', state.channel)
  if (state.province) params.set('province', state.province)
  if (state.city) params.set('city', state.city)
  if (state.state) params.set('state', state.state)
  if (state.sort !== DEFAULT_INTENT_STATE.sort) params.set('sort', state.sort)
  if (state.withPhone) params.set('with_phone', '1')
  if (state.dup) params.set('dup', '1')
  if (state.due) params.set('due', '1')
  if (state.group) params.set('group', '1')
  if (state.view !== DEFAULT_INTENT_STATE.view) params.set('view', state.view)
  if (state.page > 1) params.set('page', String(state.page))
  if (state.poolQ.trim()) params.set('pool_q', state.poolQ.trim())
  if (state.poolPage > 1) params.set('pool_page', String(state.poolPage))
  if (state.record !== null) params.set('record', String(state.record))
  return params
}

const FILTER_KEYS: Array<keyof IntentQueryState> = [
  'q',
  'level',
  'category',
  'channel',
  'province',
  'city',
  'state',
  'sort',
  'withPhone',
  'dup',
  'due',
  'scope',
]

/** 变更筛选时自动回到第 1 页（与列表分页语义一致）。 */
export function resetsPage(patch: Partial<IntentQueryState>): boolean {
  return FILTER_KEYS.some((key) => key in patch)
}

export function mergeIntentState(
  current: IntentQueryState,
  patch: Partial<IntentQueryState>
): IntentQueryState {
  const merged: IntentQueryState = { ...current, ...patch }
  if (resetsPage(patch)) merged.page = 1
  if (patch.province !== undefined && patch.city === undefined) merged.city = null
  return merged
}

export const INTENT_LIST_PAGE_SIZE = INTENT_PAGE_SIZE
export const INTENT_POOL_PAGE_SIZE_VALUE = INTENT_POOL_PAGE_SIZE

export interface UseIntentFiltersResult {
  state: IntentQueryState
  patch: (patch: Partial<IntentQueryState>) => void
  resetFilters: () => void
  openRecord: (id: number | null) => void
}

/** 页面 URL 筛选状态 hook：读写 ?tab / ?scope / ?q … / ?record。 */
export function useIntentFilters(): UseIntentFiltersResult {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const urlString = searchParams ? searchParams.toString() : ''
  const [mirror, setMirror] = useState(urlString)
  const mirrorRef = useRef(urlString)

  useEffect(() => {
    if (urlString !== mirrorRef.current) {
      mirrorRef.current = urlString
      setMirror(urlString)
    }
  }, [urlString])

  const state = useMemo(() => readIntentState(new URLSearchParams(mirror)), [mirror])

  const write = useCallback(
    (nextString: string) => {
      if (nextString === mirrorRef.current) return
      mirrorRef.current = nextString
      setMirror(nextString)
      const query = nextString ? `?${nextString}` : ''
      router.replace(`${pathname ?? ''}${query}`, { scroll: false })
    },
    [pathname, router]
  )

  const patch = useCallback(
    (next: Partial<IntentQueryState>) => {
      const current = readIntentState(new URLSearchParams(mirrorRef.current))
      const merged = mergeIntentState(current, next)
      write(buildIntentSearchParams(merged).toString())
    },
    [write]
  )

  const resetFilters = useCallback(() => {
    patch({
      q: '',
      level: null,
      category: null,
      channel: null,
      province: null,
      city: null,
      state: null,
      sort: DEFAULT_INTENT_STATE.sort,
      withPhone: false,
      dup: false,
      due: false,
      group: false,
      page: 1,
      poolQ: '',
      poolPage: 1,
    })
  }, [patch])

  const openRecord = useCallback(
    (id: number | null) => {
      patch({ record: id })
    },
    [patch]
  )

  return { state, patch, resetFilters, openRecord }
}
