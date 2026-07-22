import { describe, it, expect } from 'vitest'
import { parseSnapshot } from '../office-stream-types'

describe('parseSnapshot', () => {
  it('解析合法快照', () => {
    const snap = parseSnapshot('{"server_time":"x","employees":[]}')
    expect(snap?.employees).toEqual([])
  })
  it('非法 JSON 返回 null', () => {
    expect(parseSnapshot('not-json')).toBeNull()
  })
  it('缺 employees 返回 null', () => {
    expect(parseSnapshot('{"server_time":"x"}')).toBeNull()
  })
})
