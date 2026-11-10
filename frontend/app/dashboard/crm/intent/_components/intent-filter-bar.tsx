'use client'

import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'

import {
  WarmButton,
  WarmSegmentedControl,
  WarmSelect,
  type WarmSelectOption,
} from '@/components/dashboard-v2/warm-ledger/controls'
import {
  INTENT_LEVEL_ORDER,
  INTENT_SORT_LABELS,
  INTENT_SORT_ORDER,
  type IntentFacets,
  type IntentLevel,
  type IntentSort,
} from '@/lib/crm/intent/types'
import type { IntentQueryState } from '@/lib/crm/intent/use-intent-filters'
import { cn } from '@/lib/utils'

import styles from '../intent-warm.module.css'

const ANY = '__any__'

type IntentFilterBarProps = {
  state: IntentQueryState
  patch: (patch: Partial<IntentQueryState>) => void
  facets: IntentFacets | null
}

function levelSegments() {
  return [
    { value: 'all', label: '全部' },
    ...INTENT_LEVEL_ORDER.map((level) => ({ value: level, label: `${level} 级` })),
  ]
}

function cityOptions(facets: IntentFacets | null, province: string | null): WarmSelectOption[] {
  if (!facets || !province) return []
  const group = facets.cities.find((item) => item.province === province)
  return group ? group.cities.map((city) => ({ value: city, label: city })) : []
}

/**
 * 意向客户筛选区：搜索 + 级别 segmented + 类目/渠道/地区/状态/排序 + 高级筛选。
 * 搜索本地输入 debounce 300ms 后写 URL；其余控件即时写 URL（URL 是唯一真理源）。
 */
export function IntentFilterBar({ state, patch, facets }: IntentFilterBarProps) {
  const [keyword, setKeyword] = useState(state.q)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setKeyword((current) => (current === state.q ? current : state.q))
  }, [state.q])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleKeyword = (value: string) => {
    setKeyword(value)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => patch({ q: value }), 300)
  }

  const advancedCount =
    (state.withPhone ? 1 : 0) + (state.dup ? 1 : 0) + (state.due ? 1 : 0) + (state.group ? 1 : 0)

  const categoryOptions: WarmSelectOption[] = [
    { value: ANY, label: '全部类目' },
    ...(facets?.categories ?? []).map((category) => ({ value: category, label: category })),
  ]
  const channelOptions: WarmSelectOption[] = [
    { value: ANY, label: '全部渠道' },
    ...(facets?.channels ?? []).map((channel) => ({ value: channel, label: channel })),
  ]
  const provinceOptions: WarmSelectOption[] = [
    { value: ANY, label: '全部省份' },
    ...(facets?.provinces ?? []).map((province) => ({ value: province, label: province })),
  ]
  const cities = cityOptions(facets, state.province)
  const citySelectOptions: WarmSelectOption[] = [{ value: ANY, label: '全部城市' }, ...cities]
  const stateOptions: WarmSelectOption[] = [
    { value: ANY, label: '全部状态' },
    ...(facets?.states ?? []).map((stateFacet) => ({
      value: stateFacet.value,
      label: stateFacet.label,
    })),
  ]
  const sortOptions: WarmSelectOption[] = INTENT_SORT_ORDER.map((sort) => ({
    value: sort,
    label: INTENT_SORT_LABELS[sort],
  }))

  return (
    <div className={styles.filterBar} data-intent-filters>
      <div className={styles.filterRow}>
        <label className={styles.searchField}>
          <span className={styles.visuallyHidden}>搜索企业、法人、手机号</span>
          <Search aria-hidden="true" className={styles.searchIcon} />
          <input
            aria-label="搜索企业、法人、手机号"
            className={cn(styles.input, styles.searchInput)}
            placeholder="搜索企业、法人、手机号…"
            type="search"
            value={keyword}
            onChange={(event) => handleKeyword(event.target.value)}
          />
        </label>

        <WarmSegmentedControl
          ariaLabel="意向级别筛选"
          className={styles.levelControl}
          options={levelSegments()}
          value={state.level ?? 'all'}
          onChange={(value) =>
            patch({ level: value === 'all' ? null : (value as IntentLevel) })
          }
        />

        <WarmSelect
          className={styles.filterSelect}
          id="intent-filter-category"
          label="类目"
          options={categoryOptions}
          value={state.category ?? ANY}
          onChange={(value) => patch({ category: value === ANY ? null : value })}
        />
        <WarmSelect
          className={styles.filterSelect}
          disabled={channelOptions.length <= 1}
          id="intent-filter-channel"
          label="渠道"
          options={channelOptions}
          value={state.channel ?? ANY}
          onChange={(value) => patch({ channel: value === ANY ? null : value })}
        />
        <WarmSelect
          className={styles.filterSelect}
          id="intent-filter-province"
          label="省份"
          options={provinceOptions}
          value={state.province ?? ANY}
          onChange={(value) =>
            patch({ province: value === ANY ? null : value, city: null })
          }
        />
        <WarmSelect
          className={styles.filterSelect}
          disabled={!state.province || citySelectOptions.length <= 1}
          id="intent-filter-city"
          label="城市"
          options={citySelectOptions}
          value={state.city ?? ANY}
          onChange={(value) => patch({ city: value === ANY ? null : value })}
        />
        <WarmSelect
          className={styles.filterSelect}
          id="intent-filter-state"
          label="状态"
          options={stateOptions}
          value={state.state ?? ANY}
          onChange={(value) =>
            patch({ state: value === ANY ? null : (value as IntentQueryState['state']) })
          }
        />
        <WarmSelect
          className={styles.filterSelect}
          id="intent-filter-sort"
          label="排序"
          options={sortOptions}
          value={state.sort}
          onChange={(value) => patch({ sort: value as IntentSort })}
        />
        <WarmButton
          aria-controls="intent-advanced-filters"
          aria-expanded={advancedOpen}
          className={styles.advancedToggle}
          variant="quiet"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          高级筛选{advancedCount > 0 ? ` · ${advancedCount}` : ''}
        </WarmButton>
      </div>

      {advancedOpen ? (
        <div className={styles.advancedRow} id="intent-advanced-filters">
          <WarmSegmentedControl
            ariaLabel="只有号码"
            options={[
              { value: 'off', label: '所有号码' },
              { value: 'on', label: '只看有号码' },
            ]}
            value={state.withPhone ? 'on' : 'off'}
            onChange={(value) => patch({ withPhone: value === 'on' })}
          />
          <WarmSegmentedControl
            ariaLabel="号码重复"
            options={[
              { value: 'off', label: '所有记录' },
              { value: 'on', label: '只看号码重复' },
            ]}
            value={state.dup ? 'on' : 'off'}
            onChange={(value) => patch({ dup: value === 'on' })}
          />
          <WarmSegmentedControl
            ariaLabel="待联系"
            options={[
              { value: 'off', label: '所有记录' },
              { value: 'on', label: '只看待联系' },
            ]}
            value={state.due ? 'on' : 'off'}
            onChange={(value) => patch({ due: value === 'on' })}
          />
          <WarmSegmentedControl
            ariaLabel="卡片分组"
            options={[
              { value: 'off', label: '不分组' },
              { value: 'on', label: '按级别分组' },
            ]}
            value={state.group ? 'on' : 'off'}
            onChange={(value) => patch({ group: value === 'on' })}
          />
        </div>
      ) : null}
    </div>
  )
}
