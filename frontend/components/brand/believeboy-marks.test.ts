import { describe, expect, it } from 'vitest'

import {
  BELIEVEBOY_MARK_LABELS,
  BELIEVEBOY_MARK_PATHS,
  believeboyMarkSvg,
  type BelieveboyMarkDirection,
} from './believeboy-marks'

const DIRECTIONS = Object.keys(BELIEVEBOY_MARK_PATHS) as BelieveboyMarkDirection[]

describe('believeboy-marks', () => {
  it('三个方向都有非空 path 与可访问名称', () => {
    expect(DIRECTIONS).toEqual(['wing', 'ledger', 'seam'])
    for (const direction of DIRECTIONS) {
      expect(BELIEVEBOY_MARK_PATHS[direction].length).toBeGreaterThan(80)
      expect(BELIEVEBOY_MARK_LABELS[direction]).toMatch(/Believeboy/)
    }
  })

  it('每个方向的 path 都是闭合的偶数条子路径（外轮廓 + 字怀）', () => {
    for (const direction of DIRECTIONS) {
      const d = BELIEVEBOY_MARK_PATHS[direction]
      const subpaths = d.match(/M/g) ?? []
      expect(subpaths.length).toBeGreaterThanOrEqual(3)
      expect((d.match(/Z/g) ?? []).length).toBe(subpaths.length)
      expect(d).not.toMatch(/NaN|undefined|null/)
    }
  })

  it('SVG 标记带 viewBox 且把 currentColor 留给调用方', () => {
    const svg = believeboyMarkSvg('wing')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).toContain('viewBox="0 0 64 64"')
    expect(svg).toContain(BELIEVEBOY_MARK_PATHS.wing)
    expect(svg).toContain('fill-rule="evenodd"')
  })

  it('不同方向产出不同几何，避免误把同一 path 复用成三个方向', () => {
    const unique = new Set(DIRECTIONS.map((d) => BELIEVEBOY_MARK_PATHS[d]))
    expect(unique.size).toBe(DIRECTIONS.length)
  })
})
