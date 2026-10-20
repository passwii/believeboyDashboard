'use client'

import { useCallback, useMemo, useState } from 'react'

import { TermPanel } from '@/components/terminal/term-panel'
import { TERM_BUTTON } from '@/components/terminal/term-controls'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'

import {
  ADMISSION_STEPS,
  ANCHORS,
  CHAIN_STEPS,
  CUSTOMS_FIELDS,
  DISCLAIMER,
  FIRST_ORDER_MATERIAL_GROUPS,
  LOCAL_ONLY_NOTE,
  MATERIAL_COPY_NOTE,
  MATERIAL_SCOPE_NOTE,
  MODE_SCENARIO_LABEL,
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
    () => (TOTAL_MATERIAL_COUNT === 0 ? 0 : Math.round((checkedCount / TOTAL_MATERIAL_COUNT) * 100)),
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
        actions={<span className="font-mono text-xs text-term-faint">采购 → 销售 → 报关 → 物流 → 收汇</span>}
        bodyClassName="p-2"
      >
        <section id={ANCHORS.chain} className="scroll-mt-2">
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
        actions={<span className="font-mono text-xs text-term-faint">{MODE_SCENARIO_LABEL}</span>}
        bodyClassName="p-2"
      >
        <section id={ANCHORS.modes} className="scroll-mt-2">
          <p className="mb-2 text-xs leading-5 text-term-muted">
            以下为{MODE_SCENARIO_LABEL}，不构成推荐、适用性判断或优劣结论；实际申报模式需结合业务事实及主管机关口径确认。
          </p>
          <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
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
                  <span className="text-xs text-term-muted">{mode.name}</span>
                </div>
                <p className="text-xs leading-5 text-term-muted">{mode.scene}</p>
                <ul className="space-y-0.5">
                  {mode.highlights.map((item) => (
                    <li key={item} className="text-xs leading-5 text-term-faint">
                      · {item}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>
      </TermPanel>

      {/* ── 区块 4：企业准入办理 ─────────────────────────────────────── */}
      <TermPanel
        title="03 / 企业准入办理"
        actions={<span className="font-mono text-xs text-term-faint">课件梳理顺序</span>}
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
                  {group.items.map((item) => {
                    const id = `${group.id}-${group.items.indexOf(item)}`
                    const itemId = `material-${id}`
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
        actions={<span className="font-mono text-xs text-term-faint">{CUSTOMS_FIELDS.length} FIELDS</span>}
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
                <dd className="min-w-0 flex-1 text-xs leading-5 text-term-muted">{field.hint}</dd>
              </div>
            ))}
          </dl>
        </section>
      </TermPanel>
    </div>
  )
}
