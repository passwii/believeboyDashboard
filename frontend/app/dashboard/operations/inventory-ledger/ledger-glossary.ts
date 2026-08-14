/**
 * 库存分类账字段词典（BLF-431）— 前端侧单一真相源。
 *
 * 键 = 后端字段名（与 backend/app/schemas/inventory_ledger.py 及
 * migration 235 列名一致），值 = 中文 label（spec §6 权威词典）。
 * 另含英文列名（spec 表头 "Amazon 英文列名"），供列头 hover tooltip 使用。
 * 亚马逊枚举值（SELLABLE 等）刻意不翻译，属 BEL-428 EVENT_TYPE_LABELS /
 * DISPOSITION_LABELS 职责。
 *
 * 契约校验：frontend/.../inventory-ledger/ledger-glossary.test.ts（键集合锁定），
 * 后端侧：backend/tests/schemas/test_inventory_ledger_field_glossary.py。
 */

import glossary from '@/locales/zh-CN/inventory-ledger.json'

/** Summary 22 个业务字段：后端字段名 → 中文 label */
export const SUMMARY_LABELS: Record<string, string> = glossary.summary

/** Detail 16 个业务字段：后端字段名 → 中文 label */
export const DETAIL_LABELS: Record<string, string> = glossary.detail

/** 技术字段（id / batch_id）中文 label */
export const TECHNICAL_LABELS: Record<string, string> = glossary.technical

/** Summary 英文列名（spec 表头）→ 列头 tooltip */
export const SUMMARY_EN: Record<string, string> = glossary.en.summary

/** Detail 英文列名（spec 表头）→ 列头 tooltip */
export const DETAIL_EN: Record<string, string> = glossary.en.detail

/** 技术字段英文（由中文 label 转写，spec 技术字段表无英文列名） */
export const TECHNICAL_EN: Record<string, string> = glossary.en.technical

/** 根据后端字段名取中文 label；未知键回退为原键 */
export function summaryLabel(key: string): string {
  return SUMMARY_LABELS[key] ?? key
}

/** 根据后端字段名取英文列名；未知键回退为原键 */
export function summaryEn(key: string): string {
  return SUMMARY_EN[key] ?? key
}

export function detailLabel(key: string): string {
  return DETAIL_LABELS[key] ?? key
}

export function detailEn(key: string): string {
  return DETAIL_EN[key] ?? key
}

export function technicalLabel(key: string): string {
  return TECHNICAL_LABELS[key] ?? key
}

export function technicalEn(key: string): string {
  return TECHNICAL_EN[key] ?? key
}
