import { describe, expect, it } from 'vitest'

import {
  formatFileSize,
  proposalDownloadFilename,
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_TYPE_LABELS,
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
