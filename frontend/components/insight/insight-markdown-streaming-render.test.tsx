import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 「逐帧吐字时只重渲 tail」的机器断言（BLF-1072）。
 *
 * 为什么需要**单独一个文件**：这里把 `react-markdown` 换成计数器替身，用「解析器被
 * 调用几次」直接度量成本；同目录的 `insight-markdown.test.tsx` 断言的是真实解析结果
 * （表格 / 围栏 / 图表），两者互斥，不能放在同一文件里。
 *
 * 计数器的语义：真实实现里每次 `<ReactMarkdown>{stable}</ReactMarkdown>` 渲染都是一次
 * 从头解析；因此「计数 ≈ stable 变化次数」就等于「没有把全量重排摊到每一帧」。
 */
const parsed: string[] = []

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: unknown }) => {
    parsed.push(String(children ?? ''))
    return <div data-testid="markdown-source">{String(children ?? '')}</div>
  },
}))

const { InsightMarkdown } = await import('./insight-markdown')

/** 逐帧吐字：每帧追加一个字符，末尾补一个换行模拟真实的「行」结构。 */
function typeText(text: string, frames: number): string[] {
  const step = Math.max(1, Math.ceil(text.length / frames))
  const drafts: string[] = []
  for (let end = step; end < text.length; end += step) drafts.push(text.slice(0, end))
  drafts.push(text)
  return drafts
}

describe('InsightMarkdown 逐帧吐字渲染成本', () => {
  afterEach(() => {
    parsed.length = 0
  })

  it('每帧只更新 tail：Markdown 解析次数随「换行跨过」次数增长，而不是随帧数', () => {
    const text =
      '## 库存健康\n\n在途 1,204 件，可售 8,731 件，周转天数 32 天，建议优先核对在途批次。\n\n| SKU | 库存'
    const drafts = typeText(text, 120)
    expect(drafts.length).toBeGreaterThan(30)

    const { container, rerender } = render(<InsightMarkdown content={drafts[0]} isStreaming />)
    for (const draft of drafts.slice(1)) {
      rerender(<InsightMarkdown content={draft} isStreaming />)
    }

    const finalStable = '## 库存健康\n\n在途 1,204 件，可售 8,731 件，周转天数 32 天，建议优先核对在途批次。\n\n'
    const finalParsed = parsed[parsed.length - 1]
    expect(finalParsed).toBe(finalStable)
    const tail = container.querySelector('[data-insight-tail]')
    expect(tail?.textContent).toBe('| SKU | 库存')

    // 关键断言：解析次数贴近 stable 的实际变化次数（这里 = 已闭合前缀的去重数量），
    // 远小于帧数——否则等于每帧把全文重新解析一遍。
    const stableCounts = new Set(parsed).size
    expect(parsed.length).toBeLessThanOrEqual(stableCounts + 1)
    expect(parsed.length).toBeLessThan(drafts.length / 2)

    // 实测数字落到测试输出里，供验收引用（BLF-1072 验收 §2）。
    console.log(
      `[BLF-1072] markdown-render: frames=${drafts.length} parsed=${parsed.length} distinctStable=${stableCounts} chars=${text.length}`
    )
  })

  it('同一 stable 下 tail 每帧都在长，且不回跳不丢字', () => {
    const text = '一句话结论。'.repeat(20)
    const drafts = typeText(text, 40)

    const { container, rerender } = render(<InsightMarkdown content={drafts[0]} isStreaming />)
    let previous = container.querySelector('[data-insight-tail]')?.textContent ?? ''
    for (const draft of drafts.slice(1)) {
      rerender(<InsightMarkdown content={draft} isStreaming />)
      const current = container.querySelector('[data-insight-tail]')?.textContent ?? ''
      expect(current.startsWith(previous) || previous.startsWith(current)).toBe(true)
      previous = current
    }

    expect(container.querySelector('[data-insight-tail]')?.textContent).toBe(text)
    // 全文没有换行 → stable 恒为空 → 解析器只被调用到「同一个空串」为止。
    expect(parsed.length).toBeLessThanOrEqual(2)
  })
})
