'use client'

import { TermPanel } from '@/components/terminal/term-panel'
import {
  TermBody,
  TermCell,
  TermHead,
  TermRow,
  TermTHead,
  TermTable,
} from '@/components/terminal/term-table'

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

/**
 * 工厂佣金结算备注（终端化 BLF-835）：
 * 原 dashboard-surface 渐变卡片收口为两张 TermPanel——规则索引 + 阶梯明细表。
 */
export function CommissionRulesCard() {
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <TermPanel title="工厂佣金结算备注">
        <div className="space-y-2 p-3 text-xs leading-5 text-term-muted">
          <p>
            这里展示的是项目与工厂之间的佣金结算口径。当前先引用现有两类规则作为说明，后续可继续补充更多结算规则。
          </p>
          <TermTable>
            <TermTHead>
              <TermRow className="hover:bg-transparent">
                <TermHead>编号</TermHead>
                <TermHead>规则</TermHead>
                <TermHead>口径</TermHead>
              </TermRow>
            </TermTHead>
            <TermBody>
              {PROJECT_COMMISSION_RULES.map((item) => (
                <TermRow key={item.code}>
                  <TermCell tone="muted" className="font-mono uppercase">
                    {item.code}
                  </TermCell>
                  <TermCell className="font-medium">{item.title}</TermCell>
                  <TermCell tone={item.tag === '按回款率' ? 'warn' : undefined}>
                    {item.basis}
                  </TermCell>
                </TermRow>
              ))}
            </TermBody>
          </TermTable>
        </div>
      </TermPanel>

      <TermPanel title="阶梯明细">
        <div className="p-3">
          <TermTable>
            <TermTHead>
              <TermRow className="hover:bg-transparent">
                <TermHead>编号</TermHead>
                <TermHead>阶梯</TermHead>
                <TermHead numeric>佣金比例</TermHead>
              </TermRow>
            </TermTHead>
            <TermBody>
              {PROJECT_COMMISSION_RULES.flatMap((rule) =>
                rule.tiers.map((tier) => {
                  const [range, rate] = tier.split('->').map((s) => s.trim())
                  return (
                    <TermRow key={`${rule.code}-${tier}`}>
                      <TermCell tone="muted" className="font-mono uppercase">
                        {rule.code}
                      </TermCell>
                      <TermCell className="font-mono">{range}</TermCell>
                      <TermCell numeric className="font-medium">
                        {rate}
                      </TermCell>
                    </TermRow>
                  )
                })
              )}
            </TermBody>
          </TermTable>
        </div>
      </TermPanel>
    </div>
  )
}
