'use client'

import { WarmCrmTableScroller } from '@/components/dashboard-v2/warm-ledger/crm'
import {
  INTENT_STATE_LABELS,
  INTENT_STATE_ORDER,
  type IntentCompany,
  type IntentState,
} from '@/lib/crm/intent/types'
import {
  bestPhone,
  formatDate,
  formatMonthDayTime,
  splitProducts,
} from '@/lib/crm/intent/format'

import { IntentLevelBadge } from './intent-display'

import styles from '../intent-warm.module.css'

type IntentTableProps = {
  companies: IntentCompany[]
  onOpen: (id: number) => void
  onStateChange: (company: IntentCompany, nextState: IntentState) => void
  pendingIds: ReadonlySet<number>
}

/** 意向客户表格（表格视图）：10 列，行点击开抽屉，行内状态 change 即保存。 */
export function IntentTable({ companies, onOpen, onStateChange, pendingIds }: IntentTableProps) {
  return (
    <WarmCrmTableScroller ariaLabel="意向客户列表" interactiveRows>
      <table>
        <thead>
          <tr>
            <th className={styles.thName}>企业名称</th>
            <th>级别</th>
            <th>渠道</th>
            <th data-numeric>意向分</th>
            <th>主营产品</th>
            <th>法人</th>
            <th>手机</th>
            <th data-numeric>商标</th>
            <th>状态</th>
            <th className={styles.thAction}>详情</th>
          </tr>
        </thead>
        <tbody>
          {companies.map((company) => {
            const phone = bestPhone(company.phones)
            const productText = splitProducts(company.products).join('、')
            const channelText =
              company.channels.length > 0 ? company.channels[0] : '未标注'
            return (
              <tr key={company.id} onClick={() => onOpen(company.id)}>
                <td className={styles.tdName}>
                  <span className={styles.tableName} title={company.name}>
                    {company.name}
                  </span>
                  <span className={styles.tableSubline}>
                    {company.screenedAt ? `筛于 ${formatDate(company.screenedAt)}` : '筛选日期待补'}
                  </span>
                </td>
                <td>
                  <IntentLevelBadge level={company.intentLevel} />
                </td>
                <td className={styles.tdChannel}>
                  {channelText}
                  {company.channels.length > 1 ? (
                    <span className={styles.channelMore}>+${company.channels.length - 1}</span>
                  ) : null}
                </td>
                <td data-numeric>{company.intentScore ?? '—'}</td>
                <td className={styles.tdProducts}>
                  <span className={styles.clampLine} title={productText || '主营产品待补'}>
                    {productText || '主营产品待补'}
                  </span>
                </td>
                <td>{company.legalPerson ?? '—'}</td>
                <td className={styles.tdPhone}>{phone ?? '—'}</td>
                <td data-numeric>{company.trademarkCount > 0 ? company.trademarkCount : '—'}</td>
                <td onClick={(event) => event.stopPropagation()}>
                  <select
                    aria-label={`变更 ${company.name} 的跟进状态`}
                    className={styles.tableSelect}
                    disabled={pendingIds.has(company.id)}
                    value={company.followup.state}
                    onChange={(event) => onStateChange(company, event.target.value as IntentState)}
                  >
                    {INTENT_STATE_ORDER.map((state) => (
                      <option key={state} value={state}>
                        {INTENT_STATE_LABELS[state]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className={styles.tdAction}>
                  <button
                    aria-label={`打开 ${company.name} 详情`}
                    className={styles.tableDetail}
                    type="button"
                    onClick={() => onOpen(company.id)}
                  >
                    详情 →
                  </button>
                  {company.followup.nextContactAt ? (
                    <span className={styles.tableDue}>
                      {formatMonthDayTime(company.followup.nextContactAt)}
                    </span>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </WarmCrmTableScroller>
  )
}
