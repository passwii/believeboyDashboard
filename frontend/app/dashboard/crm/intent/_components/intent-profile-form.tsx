'use client'

import { useState, type ChangeEvent, type FormEvent } from 'react'

import { WarmButton } from '@/components/dashboard-v2/warm-ledger/controls'
import {
  INTENT_LEVEL_LABELS,
  INTENT_LEVEL_ORDER,
  type IntentCompanyDetail,
  type IntentLevel,
  type IntentProfileInput,
} from '@/lib/crm/intent/types'

import { IntentDetailSection } from './intent-display'

import styles from '../intent-warm.module.css'

type IntentProfileFormProps = {
  detail: IntentCompanyDetail
  submitting: boolean
  onCancel: () => void
  onSubmit: (input: IntentProfileInput) => void | Promise<void>
}

type FormText = {
  creditCode: string
  legalPerson: string
  province: string
  city: string
  foundedYear: string
  registeredCapitalWan: string
  products: string
  category: string
  channel: string
  channels: string
  channelSource: string
  trademarks: string
  trademarkCount: string
  intentLevel: IntentLevel
  intentScore: string
  intentBasis: string
  amazonFit: string
  walmartFit: string
  sources: string
  risks: string
  screenedAt: string
  phoneNote: string
}

function toText(value: string | number | null): string {
  return value === null ? '' : String(value)
}

function toNumber(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function toListText(values: string[]): string {
  return values.join('、')
}

function toList(value: string): string[] {
  return value
    .split(/[，,、;；\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function initialForm(detail: IntentCompanyDetail): FormText {
  return {
    creditCode: toText(detail.creditCode),
    legalPerson: toText(detail.legalPerson),
    province: toText(detail.province),
    city: toText(detail.city),
    foundedYear: toText(detail.foundedYear),
    registeredCapitalWan: toText(detail.registeredCapitalWan),
    products: toText(detail.products),
    category: toText(detail.category),
    channel: toText(detail.channel),
    channels: toListText(detail.channels),
    channelSource: toText(detail.channelSource),
    trademarks: toListText(detail.trademarks),
    trademarkCount: toText(detail.trademarkCount),
    intentLevel: detail.intentLevel,
    intentScore: toText(detail.intentScore),
    intentBasis: toText(detail.intentBasis),
    amazonFit: toText(detail.amazonFit),
    walmartFit: toText(detail.walmartFit),
    sources: toListText(detail.sources),
    risks: toText(detail.risks),
    screenedAt: toText(detail.screenedAt),
    phoneNote: toText(detail.phoneNote),
  }
}

/**
 * 抽屉「编辑资料」表单（P1-2）：人工修正锁定记录资料走这里（PATCH /profile）。
 * channel / channels / channel_source 已由 BE ProfileUpdateInput 支持人工编辑
 *（写入 human_touched），此处与其它资料字段一样可编辑提交。
 */
export function IntentProfileForm({
  detail,
  submitting,
  onCancel,
  onSubmit,
}: IntentProfileFormProps) {
  const [form, setForm] = useState<FormText>(() => initialForm(detail))

  const setField =
    (key: keyof FormText) =>
      (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
        setForm((current) => ({ ...current, [key]: event.target.value }))
      }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const input: IntentProfileInput = {
      creditCode: form.creditCode.trim() || null,
      legalPerson: form.legalPerson.trim() || null,
      province: form.province.trim() || null,
      city: form.city.trim() || null,
      foundedYear: toNumber(form.foundedYear),
      registeredCapitalWan: toNumber(form.registeredCapitalWan),
      products: form.products.trim() || null,
      category: form.category.trim() || null,
      channel: form.channel.trim() || null,
      channels: toList(form.channels),
      channelSource: form.channelSource.trim() || null,
      trademarks: toList(form.trademarks),
      trademarkCount: toNumber(form.trademarkCount),
      intentLevel: form.intentLevel,
      intentScore: toNumber(form.intentScore),
      intentBasis: form.intentBasis.trim() || null,
      amazonFit: form.amazonFit.trim() || null,
      walmartFit: form.walmartFit.trim() || null,
      sources: toList(form.sources),
      risks: form.risks.trim() || null,
      screenedAt: form.screenedAt.trim() || null,
      phoneNote: form.phoneNote.trim() || null,
    }
    void onSubmit(input)
  }

  return (
    <form className={styles.profileForm} onSubmit={handleSubmit}>
      <IntentDetailSection title="工商信息">
        <div className={styles.fieldGrid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>统一社会信用代码</span>
            <input
              aria-label="统一社会信用代码"
              className={styles.input}
              value={form.creditCode}
              onChange={setField('creditCode')}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>法人</span>
            <input
              aria-label="法人"
              className={styles.input}
              value={form.legalPerson}
              onChange={setField('legalPerson')}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>省份</span>
            <input
              aria-label="省份"
              className={styles.input}
              value={form.province}
              onChange={setField('province')}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>城市</span>
            <input
              aria-label="城市"
              className={styles.input}
              value={form.city}
              onChange={setField('city')}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>成立年份</span>
            <input
              aria-label="成立年份"
              className={styles.input}
              inputMode="numeric"
              type="number"
              value={form.foundedYear}
              onChange={setField('foundedYear')}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>注册资本（万元）</span>
            <input
              aria-label="注册资本（万元）"
              className={styles.input}
              inputMode="decimal"
              type="number"
              value={form.registeredCapitalWan}
              onChange={setField('registeredCapitalWan')}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>产品类目</span>
            <input
              aria-label="产品类目"
              className={styles.input}
              value={form.category}
              onChange={setField('category')}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>筛选日期</span>
            <input
              aria-label="筛选日期"
              className={styles.input}
              type="date"
              value={form.screenedAt}
              onChange={setField('screenedAt')}
            />
          </label>
          <label className={styles.profileWide}>
            <span className={styles.fieldLabel}>主营产品</span>
            <textarea
              aria-label="主营产品"
              className={styles.textarea}
              rows={2}
              value={form.products}
              onChange={setField('products')}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>商标（逗号分隔）</span>
            <input
              aria-label="商标"
              className={styles.input}
              value={form.trademarks}
              onChange={setField('trademarks')}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>商标数量</span>
            <input
              aria-label="商标数量"
              className={styles.input}
              inputMode="numeric"
              type="number"
              value={form.trademarkCount}
              onChange={setField('trademarkCount')}
            />
          </label>
        </div>
      </IntentDetailSection>

      <IntentDetailSection title="渠道">
        <div className={styles.fieldGrid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>渠道</span>
            <input
              aria-label="渠道"
              className={styles.input}
              value={form.channel}
              onChange={setField('channel')}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>渠道来源</span>
            <input
              aria-label="渠道来源"
              className={styles.input}
              value={form.channelSource}
              onChange={setField('channelSource')}
            />
          </label>
          <label className={styles.profileWide}>
            <span className={styles.fieldLabel}>渠道明细（逗号分隔）</span>
            <input
              aria-label="渠道明细"
              className={styles.input}
              value={form.channels}
              onChange={setField('channels')}
            />
          </label>
        </div>
      </IntentDetailSection>

      <IntentDetailSection title="意向判断">
        <div className={styles.fieldGrid}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>意向级别</span>
            <select
              aria-label="意向级别"
              className={styles.tableSelect}
              value={form.intentLevel}
              onChange={setField('intentLevel')}
            >
              {INTENT_LEVEL_ORDER.map((level) => (
                <option key={level} value={level}>
                  {level} · {INTENT_LEVEL_LABELS[level]}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>意向分数</span>
            <input
              aria-label="意向分数"
              className={styles.input}
              inputMode="numeric"
              max={100}
              min={0}
              type="number"
              value={form.intentScore}
              onChange={setField('intentScore')}
            />
          </label>
          <label className={styles.profileWide}>
            <span className={styles.fieldLabel}>意向依据</span>
            <textarea
              aria-label="意向依据"
              className={styles.textarea}
              rows={3}
              value={form.intentBasis}
              onChange={setField('intentBasis')}
            />
          </label>
        </div>
      </IntentDetailSection>

      <IntentDetailSection title="平台适配">
        <div className={styles.fieldGrid}>
          <label className={styles.profileWide}>
            <span className={styles.fieldLabel}>Amazon 适配</span>
            <textarea
              aria-label="Amazon 适配"
              className={styles.textarea}
              rows={2}
              value={form.amazonFit}
              onChange={setField('amazonFit')}
            />
          </label>
          <label className={styles.profileWide}>
            <span className={styles.fieldLabel}>Walmart 适配</span>
            <textarea
              aria-label="Walmart 适配"
              className={styles.textarea}
              rows={2}
              value={form.walmartFit}
              onChange={setField('walmartFit')}
            />
          </label>
        </div>
      </IntentDetailSection>

      <IntentDetailSection title="来源与疑点">
        <div className={styles.fieldGrid}>
          <label className={styles.profileWide}>
            <span className={styles.fieldLabel}>来源（逗号分隔）</span>
            <textarea
              aria-label="来源"
              className={styles.textarea}
              rows={2}
              value={form.sources}
              onChange={setField('sources')}
            />
          </label>
          <label className={styles.profileWide}>
            <span className={styles.fieldLabel}>疑点</span>
            <textarea
              aria-label="疑点"
              className={styles.textarea}
              rows={2}
              value={form.risks}
              onChange={setField('risks')}
            />
          </label>
          <label className={styles.profileWide}>
            <span className={styles.fieldLabel}>号码备注</span>
            <input
              aria-label="号码备注"
              className={styles.input}
              value={form.phoneNote}
              onChange={setField('phoneNote')}
            />
          </label>
        </div>
      </IntentDetailSection>

      <div className={styles.profileActions}>
        <WarmButton disabled={submitting} onClick={onCancel}>
          取消
        </WarmButton>
        <WarmButton loading={submitting} type="submit" variant="primary">
          保存资料
        </WarmButton>
      </div>
    </form>
  )
}
