'use client'

import { ArrowUpRight } from 'lucide-react'

import { WarmCrmState, WarmCrmStatusPill } from '@/components/dashboard-v2/warm-ledger/crm'
import {
  INTENT_POOL_STATUS_LABELS,
  type IntentSharedPhoneGroup,
} from '@/lib/crm/intent/types'

import { IntentLevelBadge } from './intent-display'
import { IntentDialog } from './intent-dialog'

import styles from '../intent-warm.module.css'

type SharedPhonesDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: IntentSharedPhoneGroup[]
  onSelectCompany: (id: number) => void
  onSelectPoolPhone: (phoneNormalized: string) => void
}

/** 号码共用弹层：同号可能意味着同一实控人或代记账。 */
export function SharedPhonesDialog({
  open,
  onOpenChange,
  groups,
  onSelectCompany,
  onSelectPoolPhone,
}: SharedPhonesDialogProps) {
  return (
    <IntentDialog
      description="同号可能意味着同一实控人或代记账；已筛企业可直接打开详情，待筛企业可跳到待筛池查看。"
      open={open}
      title="号码共用"
      onOpenChange={onOpenChange}
    >
      {groups.length === 0 ? (
        <WarmCrmState kind="empty" title="没有号码共用记录" />
      ) : (
        <div className={styles.sharedList}>
          {groups.map((group) => (
            <section className={styles.sharedGroup} key={group.phoneNormalized}>
              <header className={styles.sharedGroupHeader}>
                <span className={styles.sharedPhone}>{group.phoneNormalized || group.raw}</span>
                <span className={styles.sharedCount}>
                  共 {group.companies.length + group.pool.length} 家企业使用
                </span>
              </header>
              <ul className={styles.sharedRows}>
                {group.companies.map((company) => (
                  <li key={`company-${company.id}`}>
                    <button
                      className={styles.sharedRow}
                      type="button"
                      onClick={() => onSelectCompany(company.id)}
                    >
                      <IntentLevelBadge level={company.intentLevel} />
                      <span className={styles.sharedName}>{company.name}</span>
                      <span className={styles.sharedTag}>已筛</span>
                      <ArrowUpRight aria-hidden="true" />
                    </button>
                  </li>
                ))}
                {group.pool.map((poolItem) => (
                  <li key={`pool-${poolItem.id}`}>
                    <button
                      className={styles.sharedRow}
                      type="button"
                      onClick={() => onSelectPoolPhone(group.phoneNormalized || group.raw)}
                    >
                      <WarmCrmStatusPill>{INTENT_POOL_STATUS_LABELS[poolItem.status]}</WarmCrmStatusPill>
                      <span className={styles.sharedName}>{poolItem.name}</span>
                      <span className={styles.sharedTag}>待筛</span>
                      <ArrowUpRight aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </IntentDialog>
  )
}
