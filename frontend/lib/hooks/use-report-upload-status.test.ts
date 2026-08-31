import { describe, expect, it } from 'vitest'

import { reduceUploadStatus } from './use-report-upload-status'

describe('reduceUploadStatus（BLF-921 Stage 2）', () => {
  it('空 items → 0/0，missing 0', () => {
    expect(reduceUploadStatus([])).toEqual({ uploaded: 0, total: 0, missing: 0 })
  })

  it('两项目各三类型，部分 is_uploaded → 计数正确', () => {
    const items = [
      { statuses: [{ is_uploaded: true }, { is_uploaded: true }, { is_uploaded: false }] },
      { statuses: [{ is_uploaded: true }, { is_uploaded: false }, { is_uploaded: false }] },
    ]
    expect(reduceUploadStatus(items)).toEqual({ uploaded: 3, total: 6, missing: 3 })
  })

  it('全齐 → missing 0', () => {
    const items = [{ statuses: [{ is_uploaded: true }, { is_uploaded: true }] }]
    expect(reduceUploadStatus(items)).toEqual({ uploaded: 2, total: 2, missing: 0 })
  })

  it('项目无 statuses 数组按 0 容错，不产生 NaN', () => {
    const items = [{ statuses: [{ is_uploaded: true }] }, { statuses: undefined }]
    expect(reduceUploadStatus(items as never)).toEqual({ uploaded: 1, total: 1, missing: 0 })
  })
})
