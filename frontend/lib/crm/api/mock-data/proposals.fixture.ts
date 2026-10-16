import type { Proposal, ProposalVersion } from '@/lib/crm/types'

/**
 * 客户方案 mock 夹具（NEXT_PUBLIC_CRM_API_MODE=mock 时的演示数据）。
 *
 * 说明：mock 下的方案正文不落 R2，由 MockCrmClient 在内存里保存「适配后」的
 * 字符串；夹具只给元数据，让列表/详情页在无后端时可渲染版本链。
 */
const NOW = '2026-10-14T09:00:00.000Z'

export const PROPOSALS_FIXTURE: Proposal[] = [
  {
    id: 'p-1001',
    title: '亚马逊代运营入驻方案',
    proposalType: 'onboarding',
    status: 'published',
    customerId: '1',
    customerName: '深圳某某科技',
    ownerId: 'u-001',
    ownerName: '演示用户',
    currentVersionNo: 2,
    versionCount: 2,
    createdAt: '2026-10-10T02:00:00.000Z',
    updatedAt: NOW,
  },
  {
    id: 'p-1002',
    title: 'Q4 广告投放报价方案',
    proposalType: 'quotation',
    status: 'draft',
    customerId: '2',
    customerName: '杭州某某贸易',
    ownerId: 'u-001',
    ownerName: '演示用户',
    currentVersionNo: 1,
    versionCount: 1,
    createdAt: '2026-10-12T06:30:00.000Z',
    updatedAt: '2026-10-12T06:30:00.000Z',
  },
  {
    id: 'p-1003',
    title: '运营提效方法论（通用模板）',
    proposalType: 'operation',
    status: 'archived',
    ownerId: 'u-001',
    ownerName: '演示用户',
    currentVersionNo: 1,
    versionCount: 1,
    createdAt: '2026-09-28T01:00:00.000Z',
    updatedAt: '2026-10-01T01:00:00.000Z',
  },
]

export const PROPOSAL_VERSIONS_FIXTURE: ProposalVersion[] = [
  {
    id: 'pv-1001-1',
    versionNo: 1,
    originalFilename: 'onboarding-v1.html',
    contentType: 'text/html',
    fileSize: 18432,
    changeNote: '初始版本',
    createdBy: 'u-001',
    createdByName: '演示用户',
    createdAt: '2026-10-10T02:00:00.000Z',
  },
  {
    id: 'pv-1001-2',
    versionNo: 2,
    originalFilename: 'onboarding-v2.html',
    contentType: 'text/html',
    fileSize: 20117,
    changeNote: '补充服务范围与报价区间',
    createdBy: 'u-001',
    createdByName: '演示用户',
    createdAt: NOW,
  },
  {
    id: 'pv-1002-1',
    versionNo: 1,
    originalFilename: 'quotation.html',
    contentType: 'text/html',
    fileSize: 9021,
    changeNote: '初始版本',
    createdBy: 'u-001',
    createdByName: '演示用户',
    createdAt: '2026-10-12T06:30:00.000Z',
  },
  {
    id: 'pv-1003-1',
    versionNo: 1,
    originalFilename: 'methodology.html',
    contentType: 'text/html',
    fileSize: 15330,
    changeNote: '初始版本',
    createdBy: 'u-001',
    createdByName: '演示用户',
    createdAt: '2026-09-28T01:00:00.000Z',
  },
]

/** mock 预览用的占位正文（真实环境是用户上传并适配后的 HTML）。 */
export function mockProposalHtml(title: string, versionNo: number): string {
  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    `<title>${title}</title></head><body>` +
    `<h1>${title}</h1><p>这是 mock 数据的第 ${versionNo} 版正文。</p>` +
    '<p>真实环境中此处为用户上传、注入本项目主题令牌后的单个 HTML。</p>' +
    '</body></html>'
  )
}
