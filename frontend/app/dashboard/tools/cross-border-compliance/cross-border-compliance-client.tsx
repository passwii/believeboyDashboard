'use client'

import { useCallback, useMemo, useState } from 'react'

import { TermPanel } from '@/components/terminal/term-panel'
import { TERM_BUTTON } from '@/components/terminal/term-controls'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'

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
    <div className="flex min-w-0 flex-col gap-2 p-2 text-term-text md:p-3">
      {/* ── 区块 1：标题与来源提示 ───────────────────────────────────── */}
      <header className="flex min-w-0 flex-col gap-2 border-b border-term-border pb-2">
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono text-xs uppercase tracking-wider text-term-faint">
              BelieveBoy / Compliance
            </p>
            <h1 className="mt-1 text-lg font-semibold tracking-tight text-term-text">
              {PAGE_TITLE}
            </h1>
            <p className="mt-1 text-xs text-term-muted">{PAGE_SUBTITLE}</p>
          </div>
          <span className="font-mono text-xs text-term-faint">TOOLBOX / COMPLIANCE</span>
        </div>

        <div className="flex min-w-0 flex-col gap-1 border border-term-border bg-term-raised px-2 py-2 text-xs leading-5">
          <p className="font-semibold text-term-text">来源：{SOURCE_NOTE}</p>
          <p className="text-term-muted">{DISCLAIMER}</p>
        </div>

        {/* 页内锚点导航 */}
        <nav aria-label="页内导航" className="flex flex-wrap gap-1">
          {SECTION_NAV.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className={cn(
                TERM_BUTTON,
                'font-normal no-underline hover:no-underline'
              )}
            >
              <span className="font-mono text-term-faint">{section.index}</span>
              <span>{section.label}</span>
            </a>
          ))}
        </nav>
      </header>

      {/* ── 区块 2：出口业务证据链 ───────────────────────────────────── */}
      <TermPanel
        title="01 / 出口业务证据链"
        actions={
          <span className="font-mono text-xs text-term-faint">
            采购 → 销售 → 报关 → 物流 → 收汇
          </span>
        }
        bodyClassName="p-2"
      >
        <section id={ANCHORS.chain} className="scroll-mt-2">
          <p className="mb-2 text-xs leading-5 text-term-muted">
            {CHAIN_SUMMARY} · {CHAIN_SUBTITLE}
          </p>
          <ol className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-5">
            {CHAIN_STEPS.map((step, index) => (
              <li
                key={step.id}
                id={step.id}
                className="flex min-w-0 scroll-mt-2 flex-col gap-1 border border-term-border bg-term-panel p-2"
              >
                <div className="flex items-center gap-1">
                  <span className="font-mono text-xs tabular-nums text-term-faint">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span className="font-mono text-xs uppercase tracking-wider text-term-muted">
                    {step.stage}
                  </span>
                </div>
                <h3 className="text-sm font-semibold text-term-text">{step.title}</h3>
                <a
                  href={`#${step.target}`}
                  className="font-mono text-[11px] leading-4 text-term-accent underline underline-offset-2 hover:text-term-text"
                >
                  {step.compliance}
                </a>
                <ul className="space-y-0.5">
                  {step.documents.map((doc) => (
                    <li key={doc} className="text-xs leading-5 text-term-muted">
                      · {doc}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </section>
      </TermPanel>

      {/* ── 区块 3：监管模式对照 ─────────────────────────────────────── */}
      <TermPanel
        title="02 / 监管模式对照"
        actions={
          <span className="font-mono text-xs text-term-faint">{MODE_SCENARIO_LABEL}</span>
        }
        bodyClassName="p-2"
      >
        <section id={ANCHORS.modes} className="scroll-mt-2">
          <p className="mb-2 text-xs leading-5 text-term-muted">{MODE_DISCLAIMER}</p>

          {/* 3A：课件场景对照表 */}
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-xs">
              <caption className="pb-1 text-left font-mono text-[11px] uppercase tracking-wider text-term-faint">
                课件场景参考 · 业务模式对照
              </caption>
              <thead>
                <tr className="border-b border-term-border text-left text-term-faint">
                  <th scope="col" className="px-1 py-1 font-normal">
                    业务模式
                  </th>
                  <th scope="col" className="px-1 py-1 font-normal">
                    建议（课件原文）
                  </th>
                  <th scope="col" className="w-32 px-1 py-1 font-normal">
                    适用监管代码
                  </th>
                </tr>
              </thead>
              <tbody>
                {MODE_SCENARIO_ROWS.map((row) => (
                  <tr key={row.business} className="border-b border-term-border align-top">
                    <td className="px-1 py-1 font-semibold text-term-text">
                      {row.business}
                    </td>
                    <td className="px-1 py-1 leading-5 text-term-muted">{row.advice}</td>
                    <td className="px-1 py-1 font-mono text-term-muted">{row.code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-xs leading-5 text-term-faint">{MODE_TABLE_NOTE}</p>

          {/* 3B：六大业务模式核心要素对比（课件可见行） */}
          <div className="mt-3 min-w-0 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-xs">
              <caption className="pb-1 text-left font-mono text-[11px] uppercase tracking-wider text-term-faint">
                课件场景参考 · 核心要素对比
              </caption>
              <thead>
                <tr className="border-b border-term-border text-left text-term-faint">
                  <th scope="col" className="px-1 py-1 font-normal">
                    模式
                  </th>
                  <th scope="col" className="px-1 py-1 font-normal">
                    出口模式
                  </th>
                  <th scope="col" className="px-1 py-1 font-normal">
                    核心特征
                  </th>
                  <th scope="col" className="px-1 py-1 font-normal">
                    是否可退税
                  </th>
                  <th scope="col" className="px-1 py-1 font-normal">
                    优势
                  </th>
                  <th scope="col" className="px-1 py-1 font-normal">
                    缺点
                  </th>
                </tr>
              </thead>
              <tbody>
                {REGULATORY_MODES.filter((mode) => mode.feature !== '').map((mode) => (
                  <tr key={mode.code} className="border-b border-term-border align-top">
                    <td className="px-1 py-1 font-mono font-semibold text-term-text">
                      {mode.code}
                    </td>
                    <td className="px-1 py-1 leading-5 text-term-muted">{mode.name}</td>
                    <td className="px-1 py-1 leading-5 text-term-muted">{mode.feature}</td>
                    <td className="px-1 py-1 leading-5 text-term-muted">
                      {mode.refundable || '—'}
                    </td>
                    <td className="px-1 py-1 leading-5 text-term-muted">
                      {mode.strengths || '—'}
                    </td>
                    <td className="px-1 py-1 leading-5 text-term-muted">
                      {mode.weaknesses || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-xs leading-5 text-term-faint">
            课件该表只拍到序号 4 / 5 / 6 行（9710 / 9810 / 1039），序号 1-3 行未出现在照片中，故本表只列可辨认的三行。
          </p>

          {/* 3C：0110 与 9810 核心区别（六维度） */}
          <div className="mt-3 min-w-0 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-xs">
              <caption className="pb-1 text-left font-mono text-[11px] uppercase tracking-wider text-term-faint">
                课件场景参考 · 0110 与 9810 核心区别
              </caption>
              <thead>
                <tr className="border-b border-term-border text-left text-term-faint">
                  <th scope="col" className="w-28 px-1 py-1 font-normal">
                    维度
                  </th>
                  <th scope="col" className="px-1 py-1 font-normal">
                    0110（一般贸易）
                  </th>
                  <th scope="col" className="px-1 py-1 font-normal">
                    9810（跨境电商出口海外仓）
                  </th>
                </tr>
              </thead>
              <tbody>
                {MODE_COMPARISON_0110_9810.map((row) => (
                  <tr key={row.dimension} className="border-b border-term-border align-top">
                    <td className="px-1 py-1 font-semibold text-term-text">
                      {row.dimension}
                    </td>
                    <td className="px-1 py-1 leading-5 text-term-muted">
                      {row.generalTrade}
                    </td>
                    <td className="px-1 py-1 leading-5 text-term-muted">
                      {row.overseasWarehouse}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-xs leading-5 text-term-faint">{MODE_OMISSION_NOTE}</p>

          {/* 3D：各模式流程与核心要求 */}
          <div className="mt-3 grid min-w-0 grid-cols-1 gap-2 lg:grid-cols-2">
            {REGULATORY_MODES.map((mode) => (
              <article
                key={mode.code}
                className="flex min-w-0 flex-col gap-1 border border-term-border bg-term-panel p-2"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span
                    data-testid="mode-code"
                    className="font-mono text-sm font-semibold text-term-text"
                  >
                    {mode.code}
                  </span>
                  {mode.name !== mode.code ? (
                    <span className="text-xs text-term-muted">{mode.name}</span>
                  ) : null}
                </div>

                {mode.scene ? (
                  <p className="text-xs leading-5 text-term-muted">
                    课件业务模式：{mode.scene}
                  </p>
                ) : null}

                {mode.core ? (
                  <p className="text-xs leading-5 text-term-muted">
                    <span className="font-semibold text-term-text">核心要点：</span>
                    {mode.core}
                  </p>
                ) : mode.coreOmitted ? (
                  <p className="text-xs leading-5 text-term-faint">
                    <span className="font-semibold text-term-text">核心要点：</span>
                    {mode.coreOmitted}
                  </p>
                ) : null}

                {mode.audience ? (
                  <p className="text-xs leading-5 text-term-muted">
                    <span className="font-semibold text-term-text">适用主体：</span>
                    {mode.audience}
                  </p>
                ) : null}

                {mode.flow.length > 0 ? (
                  <ul className="space-y-0.5">
                    {mode.flow.map((line) => (
                      <li key={line} className="text-xs leading-5 text-term-faint">
                        · {line}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      </TermPanel>

      {/* ── 区块 4：企业准入办理 ─────────────────────────────────────── */}
      <TermPanel
        title="03 / 企业准入办理"
        actions={
          <span className="font-mono text-xs text-term-faint">{ADMISSION_SUBTITLE}</span>
        }
        bodyClassName="p-2"
      >
        <section id={ANCHORS.admission} className="scroll-mt-2">
          <p className="mb-2 text-xs leading-5 text-term-muted">
          以下为课件展示的办理事项及其逻辑关系，不宣称所有企业均须按此固定顺序办理；实际条件和顺序因地区及企业情况可能不同。
          </p>
          <ol className="min-w-0">
            {ADMISSION_STEPS.map((step, index) => (
              <li
                key={step.name}
                className="flex min-w-0 gap-2 border-t border-term-border py-2 first:border-t-0"
              >
                <span className="font-mono text-xs tabular-nums text-term-faint">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-term-text">{step.name}</h3>
                  <p className="mt-0.5 text-xs leading-5 text-term-muted">{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </TermPanel>

      {/* ── 区块 5：9810 退税准备 + 首单核查清单 ─────────────────────── */}
      <TermPanel
        title="04 / 9810 退税准备与首单核查清单"
        actions={
          <span className="font-mono text-xs text-term-faint">
            已核对 {checkedCount}/{TOTAL_MATERIAL_COUNT} · {progressPercent}%
          </span>
        }
        bodyClassName="p-2"
      >
        <section id={ANCHORS.materials} className="scroll-mt-2">
          {/* 5A：9810 必备条件 */}
          <h3 className="text-sm font-semibold text-term-text">9810 出口退税的必备条件</h3>
          <div className="mt-1 min-w-0 overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-term-border text-left text-term-faint">
                  <th scope="col" className="w-10 px-1 py-1 font-normal">
                    序号
                  </th>
                  <th scope="col" className="w-36 px-1 py-1 font-normal">
                    条件
                  </th>
                  <th scope="col" className="px-1 py-1 font-normal">
                    具体要求
                  </th>
                </tr>
              </thead>
              <tbody>
                {REFUND_CONDITIONS_9810.map((row) => (
                  <tr key={row.index} className="border-b border-term-border align-top">
                    <td className="px-1 py-1 font-mono tabular-nums text-term-faint">
                      {row.index}
                    </td>
                    <td className="px-1 py-1 font-semibold text-term-text">{row.title}</td>
                    <td className="px-1 py-1 leading-5 text-term-muted">{row.requirement}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-xs leading-5 text-term-faint">{INVOICE_SEPARATION_NOTE}</p>

          {/* 5B：首单材料清单（本地勾选自查） */}
          <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-term-text">首单核查材料清单</h3>
            <div className="flex items-center gap-2">
              <span
                data-testid="material-progress"
                className="font-mono text-xs text-term-muted"
              >
                已核对 {checkedCount}/{TOTAL_MATERIAL_COUNT} · 完成 {progressPercent}%
              </span>
              <button type="button" className={TERM_BUTTON} onClick={reset}>
                重置
              </button>
            </div>
          </div>

          <p className="mt-1 text-xs leading-5 text-term-muted">{MATERIAL_SCOPE_NOTE}</p>
          <p className="mt-0.5 text-xs leading-5 text-term-faint">{LOCAL_ONLY_NOTE}</p>

          <div className="mt-2 grid min-w-0 grid-cols-1 gap-2 lg:grid-cols-2">
            {FIRST_ORDER_MATERIAL_GROUPS.map((group) => (
              <fieldset
                key={group.id}
                className="flex min-w-0 flex-col gap-1 border border-term-border bg-term-panel p-2"
              >
                <legend className="px-1 font-mono text-xs uppercase tracking-wider text-term-muted">
                  {group.name}
                </legend>
                <ul className="space-y-1">
                  {group.items.map((item, itemIndex) => {
                    const itemId = `material-${group.id}-${itemIndex}`
                    return (
                      <li key={itemId} className="flex min-w-0 items-start gap-2">
                        <Checkbox
                          id={itemId}
                          checked={checked.has(itemId)}
                          onCheckedChange={() => toggle(itemId)}
                          aria-label={item}
                          className="mt-0.5"
                        />
                        <label
                          htmlFor={itemId}
                          className="min-w-0 flex-1 cursor-pointer text-xs leading-5 text-term-muted"
                        >
                          {item}
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </fieldset>
            ))}
          </div>

          <p className="mt-2 text-xs leading-5 text-term-faint">{MATERIAL_COPY_NOTE}</p>
        </section>
      </TermPanel>

      {/* ── 区块 6：报关字段速查 ─────────────────────────────────────── */}
      <TermPanel
        title="05 / 报关字段速查"
        actions={
          <span className="font-mono text-xs text-term-faint">
            {CUSTOMS_FIELDS.length} FIELDS
          </span>
        }
        bodyClassName="p-2"
      >
        <section id={ANCHORS.fields} className="scroll-mt-2">
          <p className="mb-2 text-xs leading-5 text-term-muted">
            以下说明用于帮助理解字段，不生成报关值、不判断填报正确性。
          </p>
          <dl className="min-w-0">
            {CUSTOMS_FIELDS.map((field) => (
              <div
                key={field.name}
                className="flex min-w-0 flex-col gap-0.5 border-t border-term-border py-2 first:border-t-0 md:flex-row md:gap-3"
              >
                <dt className="shrink-0 text-xs font-semibold text-term-text md:w-32">
                  {field.name}
                </dt>
                <dd className="min-w-0 flex-1 text-xs leading-5 text-term-muted">
                  {field.hint}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </TermPanel>
    </div>
  )
}
