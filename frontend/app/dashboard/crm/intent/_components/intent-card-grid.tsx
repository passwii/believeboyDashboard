'use client'

import {
  INTENT_LEVEL_DESCRIPTIONS,
  INTENT_LEVEL_ORDER,
  type IntentCompany,
} from '@/lib/crm/intent/types'
import {
  bestPhone,
  dueInfo,
  formatCapitalWan,
  formatMonthDayTime,
  splitProducts,
} from '@/lib/crm/intent/format'

import { IntentLevelBadge, IntentStatePill } from './intent-display'

import styles from '../intent-warm.module.css'

const MAX_CARD_PRODUCTS = 4

type IntentCardProps = {
  company: IntentCompany
  onOpen: (id: number) => void
}

function IntentCardItem({ company, onOpen }: IntentCardProps) {
  const region = [company.province, company.city].filter(Boolean).join(' · ')
  const metaParts = [
    region,
    company.category,
    company.foundedYear ? `${company.foundedYear} 年` : null,
    formatCapitalWan(company.registeredCapitalWan),
  ].filter((part): part is string => Boolean(part))
  const products = splitProducts(company.products)
  const overflowProducts = products.length - MAX_CARD_PRODUCTS
  const phone = bestPhone(company.phones)
  const validPhone = company.phones.some((item) => item.isValid)
  const due = dueInfo(company.followup.nextContactAt)
  const lastContact = company.followup.lastContactAt
    ? `上次 ${formatMonthDayTime(company.followup.lastContactAt)}`
    : '未联系'

  return (
    <button
      aria-label={`打开 ${company.name} 详情`}
      className={styles.card}
      data-intent-id={company.id}
      type="button"
      onClick={() => onOpen(company.id)}
    >
      <div className={styles.cardHead}>
        <IntentLevelBadge level={company.intentLevel} />
        <span className={styles.cardScore}>
          {company.intentScore ?? '—'}
          {company.intentScore !== null ? <span className={styles.cardScoreUnit}>分</span> : null}
        </span>
      </div>

      <h3 className={styles.cardName} title={company.name}>
        {company.name}
      </h3>

      {metaParts.length > 0 ? (
        <p className={styles.cardMeta}>{metaParts.join(' · ')}</p>
      ) : null}

      <div className={styles.cardProducts}>
        {products.length > 0 ? (
          <>
            {products.slice(0, MAX_CARD_PRODUCTS).map((product) => (
              <span key={product} className={styles.chip}>
                {product}
              </span>
            ))}
            {overflowProducts > 0 ? <span className={styles.chipMore}>+${overflowProducts}</span> : null}
          </>
        ) : (
          <span className={styles.cardMuted}>主营产品待补</span>
        )}
      </div>

      <p className={styles.cardBasis}>{company.intentBasis ?? '意向依据待补'}</p>

      <div className={styles.cardContact}>
        <span className={styles.cardPhone}>{phone ?? '手机号待补'}</span>
        {validPhone ? <span className={styles.cardValid}>✓ 有效</span> : null}
        <span className={styles.cardSources}>
          来源 {company.sources.length > 0 ? company.sources.length : '待补'}
        </span>
      </div>

      <div className={styles.cardFoot}>
        <IntentStatePill label={company.followup.stateLabel} state={company.followup.state} />
        <span className={due?.overdue ? styles.cardDue : styles.cardTime}>
          {due ? due.text : lastContact}
        </span>
      </div>
    </button>
  )
}

type IntentCardGridProps = {
  companies: IntentCompany[]
  group: boolean
  onOpen: (id: number) => void
}

/** 卡片网格：默认流式网格；分组模式按 A→B→C→D 分区（仅影响展示，不是筛选）。 */
export function IntentCardGrid({ companies, group, onOpen }: IntentCardGridProps) {
  if (!group) {
    return (
      <div className={styles.cardGrid}>
        {companies.map((company) => (
          <IntentCardItem company={company} key={company.id} onOpen={onOpen} />
        ))}
      </div>
    )
  }

  return (
    <div className={styles.cardGroups}>
      {INTENT_LEVEL_ORDER.map((level) => {
        const groupItems = companies.filter((company) => company.intentLevel === level)
        if (groupItems.length === 0) return null
        return (
          <section className={styles.cardGroup} key={level}>
            <header className={styles.cardGroupHeader}>
              <IntentLevelBadge level={level} />
              <span className={styles.cardGroupDescription}>{INTENT_LEVEL_DESCRIPTIONS[level]}</span>
              <span className={styles.cardGroupCount}>{groupItems.length} 家</span>
            </header>
            <div className={styles.cardGrid}>
              {groupItems.map((company) => (
                <IntentCardItem company={company} key={company.id} onOpen={onOpen} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
