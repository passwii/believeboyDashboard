'use client'

import { useCallback, useMemo, useState } from 'react'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'

import { ToolsPageFrame, ToolsPanel } from '../_components'
import {
  ADMISSION_STEPS,
  ADMISSION_SUBTITLE,
  ANCHORS,
  CHAIN_STEPS,
  CHAIN_SUBTITLE,
  CHAIN_SUMMARY,
  CUSTOMS_FIELDS,
  DISCLAIMER,
  FIRST_ORDER_MATERIAL_GROUPS,
  INVOICE_SEPARATION_NOTE,
  LOCAL_ONLY_NOTE,
  MATERIAL_COPY_NOTE,
  MATERIAL_SCOPE_NOTE,
  MODE_COMPARISON_0110_9810,
  MODE_DISCLAIMER,
  MODE_OMISSION_NOTE,
  MODE_SCENARIO_LABEL,
  MODE_SCENARIO_ROWS,
  MODE_TABLE_NOTE,
  PAGE_SUBTITLE,
  PAGE_TITLE,
  REFUND_CONDITIONS_9810,
  REGULATORY_MODES,
  SOURCE_NOTE,
  TOTAL_MATERIAL_COUNT,
} from './compliance-data'
import styles from './cross-border-compliance-client.module.css'

/** 区块编号 + 页内锚点导航（长页面定位）。 */
const SECTION_NAV = [
  { id: ANCHORS.chain, index: '01', label: '业务证据链' },
  { id: ANCHORS.modes, index: '02', label: '监管模式对照' },
  { id: ANCHORS.admission, index: '03', label: '企业准入办理' },
  { id: ANCHORS.materials, index: '04', label: '9810 退税与首单清单' },
  { id: ANCHORS.fields, index: '05', label: '报关字段速查' },
] as const

export default function CrossBorderComplianceClient() {
  /** 已勾选材料 id 集合（只存在于组件本地 state，不落任何持久化 / 网络通道）。 */
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set<string>())

  const toggle = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const reset = useCallback(() => {
    setChecked(new Set<string>())
  }, [])

  // 进度统计一律用 useMemo 派生：渲染期不写状态，避免无限渲染循环（计划 §6 R5）。
  const checkedCount = useMemo(() => checked.size, [checked])
  const progressPercent = useMemo(
    () =>
      TOTAL_MATERIAL_COUNT === 0
        ? 0
        : Math.round((checkedCount / TOTAL_MATERIAL_COUNT) * 100),
    [checkedCount]
  )

  return (
    <ToolsPageFrame className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <h1 className={styles.title}>{PAGE_TITLE}</h1>
          <p className={styles.subtitle}>{PAGE_SUBTITLE}</p>
        </div>

        <div className={styles.sourceNotice}>
          <p className={styles.sourceLine}>
            来源：{SOURCE_NOTE}
          </p>
          <p className={styles.disclaimer}>{DISCLAIMER}</p>
        </div>

        <nav aria-label="页内导航" className={styles.anchorNav}>
          {SECTION_NAV.map((section) => (
            <a key={section.id} href={`#${section.id}`} className={styles.anchorLink}>
              <span className={styles.anchorIndex}>{section.index}</span>
              <span>{section.label}</span>
            </a>
          ))}
        </nav>
      </header>

      <ToolsPanel
        title="01 / 出口业务证据链"
        actions={
          <span className={styles.panelMeta}>
            采购 → 销售 → 报关 → 物流 → 收汇
          </span>
        }
      >
        <section id={ANCHORS.chain} className={styles.section}>
          <p className={styles.sectionIntro}>
            {CHAIN_SUMMARY} · {CHAIN_SUBTITLE}
          </p>
          <ol className={styles.chainGrid}>
            {CHAIN_STEPS.map((step, index) => (
              <li key={step.id} id={step.id} className={styles.chainCard}>
                <div className={styles.chainMeta}>
                  <span className={styles.itemIndex}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className={styles.chainStage}>{step.stage}</span>
                </div>
                <h3 className={styles.cardTitle}>{step.title}</h3>
                <a href={`#${step.target}`} className={styles.chainLink}>
                  {step.compliance}
                </a>
                <ul className={styles.documentList}>
                  {step.documents.map((doc) => (
                    <li key={doc} className={styles.documentItem}>
                      {doc}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </section>
      </ToolsPanel>

      <ToolsPanel
        title="02 / 监管模式对照"
        actions={<span className={styles.panelMeta}>{MODE_SCENARIO_LABEL}</span>}
      >
        <section id={ANCHORS.modes} className={styles.section}>
          <p className={styles.sectionIntro}>{MODE_DISCLAIMER}</p>

          <div className={styles.tableScroll}>
            <table className={styles.dataTable}>
              <caption className={styles.tableCaption}>
                课件场景参考 · 业务模式对照
              </caption>
              <thead>
                <tr>
                  <th scope="col">业务模式</th>
                  <th scope="col">建议（课件原文）</th>
                  <th scope="col" className={styles.codeColumn}>
                    适用监管代码
                  </th>
                </tr>
              </thead>
              <tbody>
                {MODE_SCENARIO_ROWS.map((row) => (
                  <tr key={row.business}>
                    <td className={styles.strongCell}>{row.business}</td>
                    <td>{row.advice}</td>
                    <td className={styles.monoCell}>{row.code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.note}>{MODE_TABLE_NOTE}</p>

          <div className={styles.tableScroll}>
            <table className={styles.dataTable}>
              <caption className={styles.tableCaption}>
                课件场景参考 · 核心要素对比
              </caption>
              <thead>
                <tr>
                  <th scope="col">模式</th>
                  <th scope="col">出口模式</th>
                  <th scope="col">核心特征</th>
                  <th scope="col">是否可退税</th>
                  <th scope="col">优势</th>
                  <th scope="col">缺点</th>
                </tr>
              </thead>
              <tbody>
                {REGULATORY_MODES.filter((mode) => mode.feature !== '').map((mode) => (
                  <tr key={mode.code}>
                    <td className={`${styles.monoCell} ${styles.strongCell}`}>{mode.code}</td>
                    <td>{mode.name}</td>
                    <td>{mode.feature}</td>
                    <td>{mode.refundable || '—'}</td>
                    <td>{mode.strengths || '—'}</td>
                    <td>{mode.weaknesses || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.note}>
            课件该表只拍到序号 4 / 5 / 6 行（9710 / 9810 / 1039），序号 1-3 行未出现在照片中，故本表只列可辨认的三行。
          </p>

          <div className={styles.tableScroll}>
            <table className={styles.dataTable}>
              <caption className={styles.tableCaption}>
                课件场景参考 · 0110 与 9810 核心区别
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={styles.dimensionColumn}>
                    维度
                  </th>
                  <th scope="col">0110（一般贸易）</th>
                  <th scope="col">9810（跨境电商出口海外仓）</th>
                </tr>
              </thead>
              <tbody>
                {MODE_COMPARISON_0110_9810.map((row) => (
                  <tr key={row.dimension}>
                    <td className={styles.strongCell}>{row.dimension}</td>
                    <td>{row.generalTrade}</td>
                    <td>{row.overseasWarehouse}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.note}>{MODE_OMISSION_NOTE}</p>

          <div className={styles.modeGrid}>
            {REGULATORY_MODES.map((mode) => (
              <article key={mode.code} className={styles.modeCard}>
                <div className={styles.modeHeading}>
                  <span data-testid="mode-code" className={styles.modeCode}>
                    {mode.code}
                  </span>
                  {mode.name !== mode.code ? (
                    <span className={styles.modeName}>{mode.name}</span>
                  ) : null}
                </div>

                {mode.scene ? (
                  <p className={styles.modeCopy}>课件业务模式：{mode.scene}</p>
                ) : null}

                {mode.core ? (
                  <p className={styles.modeCopy}>
                    <span className={styles.inlineLabel}>核心要点：</span>
                    {mode.core}
                  </p>
                ) : mode.coreOmitted ? (
                  <p className={styles.omitted}>
                    <span className={styles.inlineLabel}>核心要点：</span>
                    {mode.coreOmitted}
                  </p>
                ) : null}

                {mode.audience ? (
                  <p className={styles.modeCopy}>
                    <span className={styles.inlineLabel}>适用主体：</span>
                    {mode.audience}
                  </p>
                ) : null}

                {mode.flow.length > 0 ? (
                  <ul className={styles.documentList}>
                    {mode.flow.map((line) => (
                      <li key={line} className={styles.flowItem}>
                        {line}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      </ToolsPanel>

      <ToolsPanel
        title="03 / 企业准入办理"
        actions={<span className={styles.panelMeta}>{ADMISSION_SUBTITLE}</span>}
      >
        <section id={ANCHORS.admission} className={styles.section}>
          <p className={styles.sectionIntro}>
            以下为课件展示的办理事项及其逻辑关系，不宣称所有企业均须按此固定顺序办理；实际条件和顺序因地区及企业情况可能不同。
          </p>
          <ol className={styles.admissionList}>
            {ADMISSION_STEPS.map((step, index) => (
              <li key={step.name} className={styles.admissionItem}>
                <span className={styles.itemIndex}>
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div className={styles.admissionCopy}>
                  <h3 className={styles.itemTitle}>{step.name}</h3>
                  <p className={styles.itemBody}>{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </ToolsPanel>

      <ToolsPanel
        title="04 / 9810 退税准备与首单核查清单"
        actions={
          <div className={styles.materialActions}>
            <span data-testid="material-progress" className={styles.progress}>
              已核对 {checkedCount}/{TOTAL_MATERIAL_COUNT} · 完成 {progressPercent}%
            </span>
            <WarmButton variant="secondary" onClick={reset}>
              重置
            </WarmButton>
          </div>
        }
      >
        <section id={ANCHORS.materials} className={styles.section}>
          <h3 className={styles.subsectionTitle}>9810 出口退税的必备条件</h3>
          <div className={styles.tableScroll}>
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th scope="col" className={styles.narrowColumn}>
                    序号
                  </th>
                  <th scope="col" className={styles.conditionColumn}>
                    条件
                  </th>
                  <th scope="col">具体要求</th>
                </tr>
              </thead>
              <tbody>
                {REFUND_CONDITIONS_9810.map((row) => (
                  <tr key={row.index}>
                    <td className={styles.monoCell}>{row.index}</td>
                    <td className={styles.strongCell}>{row.title}</td>
                    <td>{row.requirement}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.note}>{INVOICE_SEPARATION_NOTE}</p>

          <h3 className={styles.subsectionTitle}>首单核查材料清单</h3>
          <p className={styles.sectionIntro}>{MATERIAL_SCOPE_NOTE}</p>
          <p className={styles.note}>{LOCAL_ONLY_NOTE}</p>

          <div className={styles.materialGrid}>
            {FIRST_ORDER_MATERIAL_GROUPS.map((group) => (
              <fieldset key={group.id} className={styles.materialGroup}>
                <legend className={styles.materialLegend}>{group.name}</legend>
                <ul className={styles.materialList}>
                  {group.items.map((item, itemIndex) => {
                    const itemId = `material-${group.id}-${itemIndex}`
                    return (
                      <li key={itemId} className={styles.materialItem}>
                        <input
                          id={itemId}
                          type="checkbox"
                          checked={checked.has(itemId)}
                          onChange={() => toggle(itemId)}
                          className={styles.checkbox}
                        />
                        <label htmlFor={itemId} className={styles.materialLabel}>
                          {item}
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </fieldset>
            ))}
          </div>

          <p className={styles.note}>{MATERIAL_COPY_NOTE}</p>
        </section>
      </ToolsPanel>

      <ToolsPanel
        title="05 / 报关字段速查"
        actions={
          <span className={styles.panelMeta}>
            {CUSTOMS_FIELDS.length} FIELDS
          </span>
        }
      >
        <section id={ANCHORS.fields} className={styles.section}>
          <p className={styles.sectionIntro}>
            以下说明用于帮助理解字段，不生成报关值、不判断填报正确性。
          </p>
          <dl className={styles.fieldList}>
            {CUSTOMS_FIELDS.map((field) => (
              <div key={field.name} className={styles.fieldRow}>
                <dt className={styles.fieldName}>{field.name}</dt>
                <dd className={styles.fieldHint}>{field.hint}</dd>
              </div>
            ))}
          </dl>
        </section>
      </ToolsPanel>
    </ToolsPageFrame>
  )
}
