import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { InsightMarkdown } from './insight-markdown'

type ClipboardStub = { writeText: ReturnType<typeof vi.fn> }

function stubClipboard(): ClipboardStub {
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) }
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
  return clipboard
}

describe('InsightMarkdown', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps an unclosed fence and the content after it as raw text', () => {
    const renderChartBlock = vi.fn()
    const { container } = render(
      <InsightMarkdown
        content={'引入\n\n```chart\n{"type":"bar"}\n**加粗** 也是代码里的文字'}
        renderChartBlock={renderChartBlock}
      />
    )

    expect(renderChartBlock).not.toHaveBeenCalled()
    expect(container.querySelector('[data-insight-code-block]')).toBeNull()
    const tail = container.querySelector('[data-insight-tail]')
    expect(tail?.textContent).toContain('**加粗** 也是代码里的文字')
  })

  it('mounts a chart block only after its fence closed', () => {
    const renderChartBlock = vi.fn(() => <div data-testid="chart" />)
    const { container, rerender } = render(
      <InsightMarkdown content={'```chart\n{"type":"bar"}'} renderChartBlock={renderChartBlock} />
    )

    expect(renderChartBlock).not.toHaveBeenCalled()

    rerender(
      <InsightMarkdown content={'```chart\n{"type":"bar"}\n```\n'} renderChartBlock={renderChartBlock} />
    )

    expect(renderChartBlock).toHaveBeenCalledTimes(1)
    expect(renderChartBlock.mock.calls[0][0]).toEqual({ language: 'chart', code: '{"type":"bar"}' })
    expect(screen.getByTestId('chart')).toBeInTheDocument()
    expect(container.querySelector('[data-insight-tail]')).toBeNull()
  })

  it('falls back to a plain code block for closed non-chart fences', () => {
    const { container } = render(<InsightMarkdown content={'```ts\nconst a = 1\n```\n'} />)

    const block = container.querySelector('[data-insight-code-block]')
    expect(block).not.toBeNull()
    expect(block?.textContent).toContain('const a = 1')
  })

  it('renders tables inside a horizontal scroll container', () => {
    const { container } = render(<InsightMarkdown content={'| a | b |\n| - | - |\n| 1 | 2 |\n'} />)

    const scroller = container.querySelector('[data-insight-table-scroll]')
    expect(scroller).not.toBeNull()
    expect(scroller?.querySelector('table')).not.toBeNull()
  })

  it('marks the content region busy while streaming and exposes the digest on the final state', () => {
    const { container, rerender } = render(
      <InsightMarkdown content={'正文\n'} isStreaming />
    )
    expect(container.querySelector('[role="document"]')).toHaveAttribute('aria-busy', 'true')

    rerender(<InsightMarkdown content={'正文\n'} state="final" digest="sha256:abc" />)
    const region = container.querySelector('[role="document"]')
    expect(region).toHaveAttribute('data-state', 'final')
    expect(region).toHaveAttribute('data-content-digest', 'sha256:abc')
    expect(region).not.toHaveAttribute('aria-busy')
  })

  it('copies and exports the raw markdown including the un-rendered tail', async () => {
    const clipboard = stubClipboard()
    const createObjectURL = vi.fn(() => 'blob:md')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const onExportRaw = vi.fn()

    const raw = '引入\n\n```chart\n{"type":"bar"}'
    render(<InsightMarkdown content={raw} onExportRaw={onExportRaw} />)

    fireEvent.click(screen.getByRole('button', { name: /复制 Markdown/ }))
    expect(clipboard.writeText).toHaveBeenCalledWith(raw)

    fireEvent.click(screen.getByRole('button', { name: /导出 \.md/ }))
    expect(onExportRaw).toHaveBeenCalledWith(raw)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:md')
  })
})
