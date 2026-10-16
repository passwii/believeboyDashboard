/**
 * 客户方案（Proposal）前端类型。
 *
 * 层级：客户 → 方案 → 版本；文件是版本的载荷（后端 raw/adapted 两份 R2 对象）。
 * 后端 `crm_proposals` / `crm_proposal_versions`：id 为 int 主键（前端转 string），
 * owner_id/created_by 为 UUID 字符串，customer_id 为 int FK（前端转 string）。
 * 约定：可空字段 null → undefined（ownerId 例外，保留 null 表「未指派」）。
 */

import type { FilterCondition } from '../api/crm-client'

export type ProposalStatus = 'draft' | 'published' | 'archived'
export type ProposalType = 'onboarding' | 'operation' | 'quotation' | 'other'

/** 一个方案版本（append-only，不可改写）。 */
export interface ProposalVersion {
  id: string
  versionNo: number
  originalFilename: string
  contentType: string
  fileSize: number
  changeNote?: string
  createdBy?: string
  createdByName?: string
  createdAt: string
}

/** 方案主表（列表/详情共用）。 */
export interface Proposal {
  id: string
  title: string
  proposalType: ProposalType
  status: ProposalStatus
  customerId?: string
  customerName?: string
  ownerId: string | null
  ownerName?: string
  currentVersionNo: number
  versionCount: number
  createdBy?: string
  createdAt: string
  updatedAt: string
}

/** 方案详情：附完整版本链（新→旧）。 */
export interface ProposalDetail extends Proposal {
  versions: ProposalVersion[]
}

export interface ProposalListParams {
  scope?: 'mine' | 'all'
  keyword?: string
  filters?: FilterCondition[]
  sortBy?: 'updated_at' | 'created_at' | 'title' | 'current_version_no'
  sortOrder?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

/** 新建方案（首版）：multipart 上传单个 HTML。 */
export interface ProposalCreateInput {
  file: File
  title?: string
  proposalType?: ProposalType
  customerId?: string | null
  changeNote?: string
}

/** 追加新版本。 */
export interface ProposalVersionInput {
  file: File
  changeNote?: string
}

/** 部分更新（标题 / 类型 / 状态 / 关联客户）。 */
export interface ProposalUpdateInput {
  title?: string
  proposalType?: ProposalType
  status?: ProposalStatus
  customerId?: string | null
}

/** 上传返回：方案 + 该版本 + 适配提示（相对引用等）。 */
export interface ProposalUploadResult {
  proposal: Proposal
  version: ProposalVersion
  warnings: string[]
}

export interface ProposalContent {
  proposalId: string
  versionNo: number
  title: string
  content: string
}

/** 状态 → 中文标签。 */
export const PROPOSAL_STATUS_LABELS: Record<ProposalStatus, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已归档',
}

/** 类型 → 中文标签。 */
export const PROPOSAL_TYPE_LABELS: Record<ProposalType, string> = {
  onboarding: '入驻方案',
  operation: '运营方案',
  quotation: '报价方案',
  other: '其他',
}

export const PROPOSAL_STATUS_ORDER: ProposalStatus[] = ['draft', 'published', 'archived']
export const PROPOSAL_TYPE_ORDER: ProposalType[] = [
  'onboarding',
  'operation',
  'quotation',
  'other',
]

/**
 * 下载文件名（与后端 build_download_filename 同口径）：
 * `<标题>-v<N>.html` / `<标题>-v<N>-原始.html`。
 * 前端自行计算是为了不依赖响应头（blob 下载拿不到跨域 Content-Disposition）。
 */
export function proposalDownloadFilename(
  title: string,
  versionNo: number,
  raw = false
): string {
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '').trim() || '方案'
  return `${safe}-v${versionNo}${raw ? '-原始' : ''}.html`
}

/** 人类可读文件大小。 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}
