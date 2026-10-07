import { describe, expect, it } from 'vitest'

import { parseErrorText } from './error-utils'

describe('parseErrorText error-code messages', () => {
  it('prioritizes known backend deadline codes over detail/message text', () => {
    expect(
      parseErrorText(
        JSON.stringify({
          detail: 'technical database message',
          code: 'QUERY_DEADLINE_EXCEEDED',
        }),
        'fallback'
      )
    ).toBe('查询超时，请收窄筛选条件')
  })

  it('prioritizes known proxy timeout codes over detail/message text', () => {
    expect(
      parseErrorText(
        JSON.stringify({ message: 'AbortError', code: 'BACKEND_TIMEOUT' }),
        'fallback'
      )
    ).toBe('后端响应超时，请稍后重试')
  })

  it('falls back to detail/message for unknown codes', () => {
    expect(
      parseErrorText(JSON.stringify({ detail: 'Readable detail', code: 'UNKNOWN' }), 'fallback')
    ).toBe('Readable detail')
    expect(
      parseErrorText(JSON.stringify({ message: 'Readable message', code: 'UNKNOWN' }), 'fallback')
    ).toBe('Readable message')
  })
})
