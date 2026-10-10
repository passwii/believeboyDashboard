import { describe, expect, it } from 'vitest'

import {
  MAX_TEXT_CHARS,
  MAX_TEXT_LINES,
  fallbackFilename,
  parseContentDispositionFilename,
  validateBeforeGenerate,
} from './product-label'

describe('parseContentDispositionFilename', () => {
  it('优先取 RFC 5987 的 filename*（含中文时后端只在这里给全名）', () => {
    expect(
      parseContentDispositionFilename(
        "attachment; filename=\"label-labeled.pdf\"; filename*=UTF-8''%E4%BA%A7%E5%93%81-label.pdf"
      )
    ).toBe('产品-label.pdf')
  })

  it('没有 filename* 时退回普通 filename', () => {
    expect(parseContentDispositionFilename('attachment; filename="label-labeled.pdf"')).toBe(
      'label-labeled.pdf'
    )
  })

  it('filename* 的非法百分号编码时退回普通 filename，不抛错', () => {
    expect(
      parseContentDispositionFilename('attachment; filename="fallback.pdf"; filename*=UTF-8\'\'%E0%A4%A')
    ).toBe('fallback.pdf')
  })

  it('头部缺失或为空时返回 null，由调用方兜底', () => {
    expect(parseContentDispositionFilename(null)).toBeNull()
    expect(parseContentDispositionFilename('')).toBeNull()
    expect(parseContentDispositionFilename('attachment')).toBeNull()
  })
})

describe('fallbackFilename', () => {
  it('把源文件名替换为 -labeled 后缀', () => {
    expect(fallbackFilename('My Label.pdf')).toBe('My Label-labeled.pdf')
  })

  it('大小写不敏感的扩展名也能剥掉', () => {
    expect(fallbackFilename('LABEL.PDF')).toBe('LABEL-labeled.pdf')
  })

  it('文件名异常时回落到 label-labeled.pdf', () => {
    expect(fallbackFilename('')).toBe('label-labeled.pdf')
    expect(fallbackFilename('.pdf')).toBe('label-labeled.pdf')
  })
})

describe('validateBeforeGenerate', () => {
  it('既没文案也没勾选时拦下', () => {
    expect(validateBeforeGenerate('   ', false)).toBe('请至少填写「文案」或勾选「Made In China」。')
  })

  it('只勾选 Made In China 时通过', () => {
    expect(validateBeforeGenerate('', true)).toBeNull()
  })

  it('只填文案时通过', () => {
    expect(validateBeforeGenerate('Designed in California', false)).toBeNull()
  })

  it('超过字数上限时拦下', () => {
    expect(validateBeforeGenerate('x'.repeat(MAX_TEXT_CHARS + 1), false)).toContain('过长')
  })

  it('超过行数上限时拦下（后端只会取前几行，不能静默丢内容）', () => {
    const text = Array.from({ length: MAX_TEXT_LINES + 1 }, (_, i) => `line ${i}`).join('\n')
    expect(validateBeforeGenerate(text, false)).toContain('最多')
  })

  it('空行不计入行数', () => {
    expect(validateBeforeGenerate('a\n\n\nb', false)).toBeNull()
  })
})
