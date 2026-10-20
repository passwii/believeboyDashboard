import { describe, expect, it } from 'vitest'

import {
  formatFileSize,
  proposalDownloadFilename,
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_TYPE_LABELS,
  PROPOSAL_TYPE_ORDER,
  type ProposalType,
} from './proposal'

describe('proposalDownloadFilename', () => {
  it('适配版：<标题>-v<N>.html', () => {
    expect(proposalDownloadFilename('亚马逊代运营入驻方案', 2)).toBe(
      '亚马逊代运营入驻方案-v2.html'
    )
  })

  it('原始版：<标题>-v<N>-原始.html', () => {
    expect(proposalDownloadFilename('报价方案', 1, true)).toBe('报价方案-v1-原始.html')
  })

  it('剔除文件名非法字符', () => {
    expect(proposalDownloadFilename('a/b:c*?"<>|d', 3)).toBe('abcd-v3.html')
  })

  it('空标题回退「方案」', () => {
    expect(proposalDownloadFilename('   ', 1)).toBe('方案-v1.html')
  })
})

describe('formatFileSize', () => {
  it('B / KB / MB 三档', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(2048)).toBe('2.0 KB')
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.00 MB')
  })
})

describe('枚举标签', () => {
  it('状态与类型中文标签齐全', () => {
    expect(PROPOSAL_STATUS_LABELS.draft).toBe('草稿')
    expect(PROPOSAL_STATUS_LABELS.published).toBe('已发布')
    expect(PROPOSAL_STATUS_LABELS.archived).toBe('已归档')
    expect(PROPOSAL_TYPE_LABELS.quotation).toBe('报价方案')
  })
})

/**
 * BLF-1407：新增「调研方案」类型（`research`）。
 *
 * 方案类型是**枚举驱动**的（新建/编辑/筛选三处下拉都 map `PROPOSAL_TYPE_ORDER`），
 * 所以「加一处即全链路生效」的前提是 union / LABELS / ORDER **三处同步**。
 * 这里把三者的对应关系钉死：ORDER 覆盖 union 的全部值、LABELS 每个值都有中文标签、
 * 且 ORDER 无重复（重复会让下拉出现两个同值 option）。
 */
describe('方案类型枚举（BLF-1407 新增 research）', () => {
  const ALL_TYPES: ProposalType[] = [
    'onboarding',
    'operation',
    'quotation',
    'research',
    'other',
  ]

  it('research 的中文标签是「调研方案」', () => {
    expect(PROPOSAL_TYPE_LABELS.research).toBe('调研方案')
  })

  it('ORDER 覆盖 union 的全部类型且无重复', () => {
    expect([...PROPOSAL_TYPE_ORDER].sort()).toEqual([...ALL_TYPES].sort())
    expect(new Set(PROPOSAL_TYPE_ORDER).size).toBe(PROPOSAL_TYPE_ORDER.length)
  })

  it('每个类型都有中文标签（无 undefined 兜底）', () => {
    for (const t of ALL_TYPES) {
      expect(PROPOSAL_TYPE_LABELS[t]).toBeTruthy()
    }
  })

  it('ORDER 里 research 排在 quotation 之后、other 之前', () => {
    expect(PROPOSAL_TYPE_ORDER.indexOf('research')).toBe(
      PROPOSAL_TYPE_ORDER.indexOf('quotation') + 1
    )
    expect(PROPOSAL_TYPE_ORDER.indexOf('research')).toBeLessThan(
      PROPOSAL_TYPE_ORDER.indexOf('other')
    )
  })
})
