'use client'

import styles from './commission-management-warm.module.css'

const PROJECT_COMMISSION_RULES = [
  {
    code: 'Rule 01',
    title: '销售额佣金计算',
    tag: '按销售额',
    basis: '按月销售收入与项目佣金点数核算',
    description: '按销售额提成',
    tiers: [] as string[],
  },
  {
    code: 'Rule 02',
    title: '回款佣金核算',
    tag: '按回款率',
    basis: '按回款率阶梯自动核算项目佣金',
    description: '按回款提成',
    tiers: ['40% - 50% -> 7%', '50% - 60% -> 10%', '60% - 70% -> 13%', '70% 以上 -> 15%'],
  },
] as const

export function CommissionRulesCard() {
  return (
    <div className={styles.rulesGrid}>
      <section className={styles.rulesPanel} aria-labelledby="commission-rule-basis-title">
        <header className={styles.rulesHeader}>
          <h2 id="commission-rule-basis-title" className={styles.rulesTitle}>
            工厂佣金结算备注
          </h2>
        </header>
        <div className={styles.rulesBody}>
          <p className={styles.rulesCopy}>
            这里展示的是项目与工厂之间的佣金结算口径。当前先引用现有两类规则作为说明，后续可继续补充更多结算规则。
          </p>
          <table className={styles.rulesTable} data-warm-table="true">
            <thead>
              <tr>
                <th>编号</th>
                <th>规则</th>
                <th>口径</th>
              </tr>
            </thead>
            <tbody>
              {PROJECT_COMMISSION_RULES.map((item) => (
                <tr key={item.code}>
                  <td className={styles.tableCellMono}>{item.code}</td>
                  <td className={styles.tableCellStrong}>{item.title}</td>
                  <td>{item.basis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.rulesPanel} aria-labelledby="commission-rule-tiers-title">
        <header className={styles.rulesHeader}>
          <h2 id="commission-rule-tiers-title" className={styles.rulesTitle}>
            阶梯明细
          </h2>
        </header>
        <div className={styles.rulesBody}>
          <table className={styles.rulesTable} data-warm-table="true">
            <thead>
              <tr>
                <th>编号</th>
                <th>阶梯</th>
                <th className={styles.rulesNumeric}>佣金比例</th>
              </tr>
            </thead>
            <tbody>
              {PROJECT_COMMISSION_RULES.flatMap((rule) =>
                rule.tiers.map((tier) => {
                  const [range, rate] = tier.split('->').map((value) => value.trim())
                  return (
                    <tr key={`${rule.code}-${tier}`}>
                      <td className={styles.tableCellMono}>{rule.code}</td>
                      <td className={styles.tableCellMono}>{range}</td>
                      <td className={`${styles.tableCellStrong} ${styles.rulesNumeric}`}>
                        {rate}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
