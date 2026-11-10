'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'

import {
  WarmCrmState,
  WarmCrmStatusPill,
  WarmCrmTableFrame,
  WarmCrmTableScroller,
} from '@/components/dashboard-v2/warm-ledger/crm'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  INTENT_POOL_PAGE_SIZE,
  INTENT_POOL_STATUS_LABELS,
  type IntentPoolPage,
} from '@/lib/crm/intent/types'
import { apiErrorMessage } from '@/lib/crm/intent/http-client'
import { useIntentClient } from '@/lib/crm/intent/provider'
import { cn } from '@/lib/utils'

import { IntentPagination } from './intent-display'

import styles from '../intent-warm.module.css'

type IntentPoolTabProps = {
  q: string
  page: number
  revision: string
  onSearch: (q: string) => void
  onPage: (page: number) => void
}

function websiteHost(website: string | null): string | null {
  if (!website) return null
  try {
    const url = new URL(website)
    return url.host
  } catch {
    return null
  }
}

/** 待筛池：只读表格 60/页 + 搜索（不做页面内筛选动作，筛选由 AI 流水线完成）。 */
export function IntentPoolTab({ q, page, revision, onSearch, onPage }: IntentPoolTabProps) {
  const client = useIntentClient()
  const [keyword, setKeyword] = useState(q)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [result, setResult] = useState<{ signature: string; page: IntentPoolPage } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ signature: string; message: string } | null>(null)
  const [retrySeq, setRetrySeq] = useState(0)

  useEffect(() => {
    setKeyword((current) => (current === q ? current : q))
  }, [q])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const querySignature = useMemo(
    () => JSON.stringify([q, page, retrySeq]),
    [q, page, retrySeq]
  )
  const fetchSignature = useMemo(
    () => JSON.stringify([querySignature, revision]),
    [querySignature, revision]
  )

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    client
      .getPool(
        { q: q.trim() || undefined, page, pageSize: INTENT_POOL_PAGE_SIZE },
        { signal: controller.signal }
      )
      .then((poolPage) => {
        if (!cancelled) setResult({ signature: querySignature, page: poolPage })
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError({ signature: querySignature, message: apiErrorMessage(reason, '加载待筛池失败') })
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [client, q, page, querySignature, fetchSignature])

  const poolPage = result?.signature === querySignature ? result.page : null
  const errorMessage = error?.signature === querySignature ? error.message : null
  const isLoading = loading || (result?.signature !== querySignature && !errorMessage)

  const handleKeyword = (value: string) => {
    setKeyword(value)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => onSearch(value), 300)
  }

  const start = poolPage ? (poolPage.page - 1) * INTENT_POOL_PAGE_SIZE : 0

  const footer = poolPage ? (
    <div className={styles.listFooter}>
      <span className={styles.footerStatus}>
        共 {poolPage.total} 条 · 本页 {poolPage.items.length > 0 ? start + 1 : 0}–
        {start + poolPage.items.length} 条 · 每页 {INTENT_POOL_PAGE_SIZE} 条
      </span>
      <IntentPagination
        onPage={onPage}
        page={poolPage.page}
        pageSize={INTENT_POOL_PAGE_SIZE}
        total={poolPage.total}
        unit="条"
      />
    </div>
  ) : null

  const search = (
    <div className={styles.poolToolbar}>
      <label className={styles.searchField}>
        <span className={styles.visuallyHidden}>搜索企业名、法人、手机号</span>
        <Search aria-hidden="true" className={styles.searchIcon} />
        <input
          aria-label="搜索企业名、法人、手机号"
          className={cn(styles.input, styles.searchInput)}
          placeholder="搜索企业名 / 法人 / 手机号…"
          type="search"
          value={keyword}
          onChange={(event) => handleKeyword(event.target.value)}
        />
      </label>
    </div>
  )

  return (
    <div className={styles.listColumn}>
      {search}
      <WarmCrmTableFrame className={styles.poolFrame} footer={footer}>
        {isLoading && !poolPage ? (
          <div className={styles.stateWrap}>
            <WarmCrmState kind="loading" title="正在加载待筛池…" />
          </div>
        ) : errorMessage && !poolPage ? (
          <div className={styles.stateWrap}>
            <WarmCrmState
              action={
                <WarmButton onClick={() => setRetrySeq((value) => value + 1)}>重试</WarmButton>
              }
              detail={errorMessage}
              kind="error"
              title="待筛池加载失败"
            />
          </div>
        ) : !poolPage || poolPage.items.length === 0 ? (
          <div className={styles.stateWrap}>
            <WarmCrmState
              detail="今天的批次已经把名录筛完了。"
              kind="empty"
              title="待筛池是空的"
            />
          </div>
        ) : (
          <WarmCrmTableScroller ariaLabel="待筛池列表">
            <table>
              <thead>
                <tr>
                  <th data-numeric>序号</th>
                  <th>企业名称</th>
                  <th>渠道</th>
                  <th>法人</th>
                  <th>手机号</th>
                  <th>网址</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {poolPage.items.map((item, index) => {
                  const primary = item.phones[0]
                  const phone = primary?.normalized || primary?.raw || null
                  const host = websiteHost(item.website)
                  const channel = item.channels[0] ?? item.channel
                  return (
                    <tr key={item.id}>
                      <td data-numeric>{start + index + 1}</td>
                      <td className={styles.tdName}>
                        <span className={styles.tableName} title={item.name}>
                          {item.name}
                        </span>
                      </td>
                      <td className={styles.tdChannel}>
                        {channel ?? '未标注'}
                        {item.channels.length > 1 ? (
                          <span className={styles.channelMore}>+${item.channels.length - 1}</span>
                        ) : null}
                      </td>
                      <td>{item.legalPerson ?? '—'}</td>
                      <td className={styles.tdPhone}>
                        {phone ? (
                          <a className={styles.phoneLink} href={`tel:${phone}`}>
                            {phone}
                          </a>
                        ) : (
                          '—'
                        )}
                        {item.phones.length > 1 ? (
                          <span className={styles.channelMore}>+${item.phones.length - 1}</span>
                        ) : null}
                      </td>
                      <td>
                        {item.website && host ? (
                          <a
                            className={styles.websiteLink}
                            href={item.website}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            {host}
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <WarmCrmStatusPill>{INTENT_POOL_STATUS_LABELS[item.status]}</WarmCrmStatusPill>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </WarmCrmTableScroller>
        )}
      </WarmCrmTableFrame>
    </div>
  )
}
export default IntentPoolTab
