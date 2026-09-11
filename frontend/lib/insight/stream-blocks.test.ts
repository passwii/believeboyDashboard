import { describe, expect, it } from 'vitest'

import { splitStreamingMarkdown } from './stream-blocks'

describe('splitStreamingMarkdown', () => {
  it('treats a newline-terminated draft as fully stable', () => {
    expect(splitStreamingMarkdown('## 标题\n\n正文\n')).toEqual({
      stable: '## 标题\n\n正文\n',
      tail: '',
    })
  })

  it('keeps the line still being typed raw so half-written blocks are not parsed', () => {
    expect(splitStreamingMarkdown('已完成段落\n\n| 项目 | 值 |')).toEqual({
      stable: '已完成段落\n\n',
      tail: '| 项目 | 值 |',
    })
    expect(splitStreamingMarkdown('- 第一项\n- 第二')).toEqual({
      stable: '- 第一项\n',
      tail: '- 第二',
    })
  })

  it('keeps an unclosed fence and everything after it in the raw tail', () => {
    const { stable, tail } = splitStreamingMarkdown('引入\n\n```js\nconst a = 1\n**不是加粗**')

    expect(stable).toBe('引入\n\n')
    expect(tail).toBe('```js\nconst a = 1\n**不是加粗**')
  })

  it('returns to stable once the fence closes and is terminated', () => {
    const { stable, tail } = splitStreamingMarkdown('引入\n\n```js\nconst a = 1\n```\n\n**加粗**\n')

    expect(stable).toBe('引入\n\n```js\nconst a = 1\n```\n\n**加粗**\n')
    expect(tail).toBe('')
  })

  it('keeps a closing fence line raw until it is newline-terminated', () => {
    expect(splitStreamingMarkdown('```js\nconst a = 1\n```')).toEqual({
      stable: '```js\nconst a = 1\n',
      tail: '```',
    })
  })

  it('supports tilde fences and longer markers', () => {
    expect(splitStreamingMarkdown('~~~\ncode\n~~~\n')).toEqual({
      stable: '~~~\ncode\n~~~\n',
      tail: '',
    })
    expect(splitStreamingMarkdown('````\ncode\n```\n').tail).toBe('````\ncode\n```\n')
  })

  it('does not close a fence with a different marker or shorter run', () => {
    const { tail } = splitStreamingMarkdown('```\n~~~\n')
    expect(tail).toBe('```\n~~~\n')
  })

  it('never splits an empty draft', () => {
    expect(splitStreamingMarkdown('')).toEqual({ stable: '', tail: '' })
  })
})
