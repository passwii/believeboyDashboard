import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRhythmPlayer, type RhythmBucket, type RhythmConfig } from '../rhythm-player'

const baseConfig: RhythmConfig = {
  intervalMs: 3000,        // 普通节奏
  tailExtendMs: 12000,     // 末尾延长
  idleAfterMs: 30000,      // 空闲后切到"下班"
}

function makeBucket(project: string, reportType: string): RhythmBucket {
  return {
    id: `${project}-${reportType}`,
    projectName: project,
    reportType,
    reportLabel: 'Payment Report',
    status: 'SUCCEEDED',
    eventCount: 1,
    rowCountTotal: 100,
    firstOccurredAt: new Date(),
    lastOccurredAt: new Date(),
    dateRange: '06-05~06-05',
  }
}

describe('RhythmPlayer', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('初始为空闲态', () => {
    const player = createRhythmPlayer(baseConfig)
    expect(player.snapshot().state).toBe('IDLE')
  })

  it('喂入单桶后立即进入 WORKING', () => {
    const player = createRhythmPlayer(baseConfig)
    player.feed([makeBucket('润茗', 'payment_report')])
    expect(player.snapshot().state).toBe('WORKING')
  })

  it('普通节奏：队列还有 → 切下一桶前等 intervalMs', () => {
    const player = createRhythmPlayer(baseConfig)
    player.feed([makeBucket('润茗', 'payment_report'), makeBucket('弥森', 'business_report')])
    expect(player.snapshot().currentBucketId).toBe('润茗-payment_report')

    vi.advanceTimersByTime(2999)
    expect(player.snapshot().currentBucketId).toBe('润茗-payment_report')

    vi.advanceTimersByTime(1)
    expect(player.snapshot().currentBucketId).toBe('弥森-business_report')
  })

  it('末尾延长：最后一个桶多等 tailExtendMs 才切到 IDLE', () => {
    const player = createRhythmPlayer(baseConfig)
    player.feed([makeBucket('润茗', 'payment_report')])
    // intervalMs(3s) 后队列仍为空 → 切到 IDLE 的等待时间是 tailExtendMs
    vi.advanceTimersByTime(3000)
    expect(player.snapshot().state).toBe('WORKING')  // 仍在等 tailExtend

    vi.advanceTimersByTime(11999)  // 累计 15s 仍 WORKING
    expect(player.snapshot().state).toBe('WORKING')

    vi.advanceTimersByTime(1)  // 累计 15s 整 → IDLE
    expect(player.snapshot().state).toBe('IDLE')
  })

  it('空闲超时：IDLE 持续 idleAfterMs 后切到 OFFLINE', () => {
    const player = createRhythmPlayer(baseConfig)
    // 进入 IDLE 状态
    player.feed([makeBucket('润茗', 'payment_report')])
    vi.advanceTimersByTime(3000)  // → WORKING（等 tailExtend）
    vi.advanceTimersByTime(12000) // → IDLE

    expect(player.snapshot().state).toBe('IDLE')

    vi.advanceTimersByTime(30000) // 累计 idleAfterMs 后 → OFFLINE
    expect(player.snapshot().state).toBe('OFFLINE')
  })

  it('WORKING 期间追加新桶，会出现在队列里但当前桶不变', () => {
    const player = createRhythmPlayer(baseConfig)
    player.feed([makeBucket('润茗', 'payment_report')])
    expect(player.snapshot().currentBucketId).toBe('润茗-payment_report')

    // 工作中追加新桶
    player.feed([makeBucket('弥森', 'business_report')])
    expect(player.snapshot().currentBucketId).toBe('润茗-payment_report')

    // 3 秒后切到弥森
    vi.advanceTimersByTime(3000)
    expect(player.snapshot().currentBucketId).toBe('弥森-business_report')
  })

  it('dispose 清理定时器', () => {
    const player = createRhythmPlayer(baseConfig)
    player.feed([makeBucket('润茗', 'payment_report')])
    player.dispose()
    vi.advanceTimersByTime(10000)
    // 状态不再变化
    expect(player.snapshot().currentBucketId).toBe('润茗-payment_report')
  })

  it('OFFLINE 状态下再 feed 桶能重新激活', () => {
    const player = createRhythmPlayer(baseConfig)
    player.feed([makeBucket('润茗', 'payment_report')])
    vi.advanceTimersByTime(3000)  // WORKING 等 tail
    vi.advanceTimersByTime(12000) // IDLE
    vi.advanceTimersByTime(30000) // OFFLINE
    expect(player.snapshot().state).toBe('OFFLINE')

    player.feed([makeBucket('弥森', 'business_report')])
    expect(player.snapshot().state).toBe('WORKING')
    expect(player.snapshot().currentBucketId).toBe('弥森-business_report')
  })
})
