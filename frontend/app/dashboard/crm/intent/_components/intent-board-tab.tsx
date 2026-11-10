'use client'

import { useEffect, useMemo, useState } from 'react'

import { WarmCrmState, WarmCrmStatusPill } from '@/components/dashboard-v2/warm-ledger/crm'
import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  INTENT_STATE_LABELS,
  type IntentBoard,
  type IntentBoardItem,
  type IntentState,
} from '@/lib/crm/intent/types'
import { dueInfo, formatMonthDayTime } from '@/lib/crm/intent/format'
import { apiErrorMessage } from '@/lib/crm/intent/http-client'
import { useIntentClient } from '@/lib/crm/intent/provider'

import { IntentLevelBadge } from './intent-display'

import styles from '../intent-warm.module.css'

type IntentBoardTabProps = {
  scope: 'mine' | 'all' | 'sea'
  revision: string
  onOpen: (id: number) => void
  onFilterState: (state: IntentState) => void
}

const BOARD_COLUMN_LIMIT = 8

/** 跟进看板：8 列横向滚动（count + top8 + 另有 N 家）。 */
export function IntentBoardTab({ scope, revision, onOpen, onFilterState }: IntentBoardTabProps) {
  const client = useIntentClient()
  const [result, setResult] = useState<{ signature: string; board: IntentBoard } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ signature: string; message: string } | null>(null)
  const [retrySeq, setRetrySeq] = useState(0)

  const querySignature = useMemo(() => JSON.stringify([scope, retrySeq]), [scope, retrySeq])
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
      .getBoard(scope, { signal: controller.signal })
      .then((board) => {
        if (!cancelled) setResult({ signature: querySignature, board })
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError({ signature: querySignature, message: apiErrorMessage(reason, '加载跟进看板失败') })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [client, scope, querySignature, fetchSignature])

  const board = result?.signature === querySignature ? result.board : null
  const errorMessage = error?.signature === querySignature ? error.message : null
  const isLoading = loading || (result?.signature !== querySignature && !errorMessage)

  if (isLoading && !board) {
    return <WarmCrmState kind="loading" title="正在加载跟进看板…" />
  }
  if (errorMessage && !board) {
    return (
      <WarmCrmState
        action={<WarmButton onClick={() => setRetrySeq((value) => value + 1)}>重试</WarmButton>}
        detail={errorMessage}
        kind="error"
        title="跟进看板加载失败"
      />
    )
  }
  if (!board) return <WarmCrmState kind="empty" title="暂无跟进记录" />

  if (board.total === 0) {
    return (
      <WarmCrmState
        detail="在意向客户里把企业状态改成已联系 / 已加微信，这里就会分组显示。"
        kind="empty"
        title="还没有跟进记录"
      />
    )
  }

  const maxCount = Math.max(1, ...board.groups.map((group) => group.count))

  return (
    <div className={styles.boardScroll}>
      <div className={styles.board}>
        {board.groups.map((group) => {
          const proportion = Math.max(
            group.count > 0 ? 4 : 0,
            Math.round((group.count / maxCount) * 100)
          )
          return (
            <section className={styles.boardColumn} key={group.state}>
              <header className={styles.boardColumnHeader}>
                <IntentBoardHeader state={group.state} label={group.stateLabel} />
                <span className={styles.boardCount}>{group.count}</span>
                <div aria-hidden="true" className={styles.boardBar}>
                  <span style={{ width: `${proportion}%` }} />
                </div>
              </header>
              {group.items.length > 0 ? (
                <ul className={styles.boardList}>
                  {group.items.slice(0, BOARD_COLUMN_LIMIT).map((item) => (
                    <li key={item.id}>
                      <button
                        aria-label={`打开 ${item.name} 详情`}
                        className={styles.boardItem}
                        type="button"
                        onClick={() => onOpen(item.id)}
                      >
                        <span className={styles.boardItemTop}>
                          <IntentLevelBadge level={item.intentLevel} />
                          <span className={styles.boardItemName} title={item.name}>
                            {item.name}
                          </span>
                        </span>
                        {renderBoardSecondary(item)}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className={styles.boardEmpty}>暂无</span>
              )}
              {group.count > group.items.length ? (
                <button
                  className={styles.boardMore}
                  type="button"
                  onClick={() => onFilterState(group.state)}
                >
                  另有 {group.count - group.items.length} 家
                </button>
              ) : null}
            </section>
          )
        })}
      </div>
    </div>
  )
}

/** 看板条目副行：只用 BE BoardItem 实际字段（next_contact_at / owner），无手机号字段。 */
function renderBoardSecondary(item: IntentBoardItem) {
  if (item.nextContactAt) {
    const due = dueInfo(item.nextContactAt)
    return (
      <span className={due?.overdue ? styles.boardItemDue : styles.boardItemSecondary}>
        {due?.text ?? `下次 ${formatMonthDayTime(item.nextContactAt)}`}
      </span>
    )
  }
  if (item.owner) {
    return (
      <span className={styles.boardItemSecondary}>
        负责人 {item.owner.name || item.owner.id}
      </span>
    )
  }
  return null
}

function IntentBoardHeader({ state, label }: { state: IntentState; label: string }) {
  return (
    <WarmCrmStatusPill className={styles.boardPill}>
      {label || INTENT_STATE_LABELS[state]}
    </WarmCrmStatusPill>
  )
}
export default IntentBoardTab
