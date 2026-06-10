/**
 * 节奏播放器 — 拟人化展示层的核心纯逻辑模块。
 *
 * 状态机：IDLE → WORKING → (IDLE) → OFFLINE
 *         ^                                  |
 *         └──────── feed() ──────────────────┘
 *
 * 节奏规则：
 * - 切到新桶：等 intervalMs 后看是否还有下一桶
 *   - 还有 → 切下一桶，等 intervalMs
 *   - 没有 → 末尾延长，等 tailExtendMs
 * - 末尾延长 tailExtendMs 后切到 IDLE
 * - IDLE 持续 idleAfterMs 后切到 OFFLINE
 */

export type RhythmState = 'IDLE' | 'WORKING' | 'OFFLINE'

export interface RhythmBucket {
  id: string
  projectName: string
  reportType: string
  reportLabel: string
  status: 'SUCCEEDED' | 'FAILED' | 'RUNNING' | 'PENDING'
  eventCount: number
  rowCountTotal: number
  firstOccurredAt: Date
  lastOccurredAt: Date
  dateRange: string
}

export interface RhythmConfig {
  intervalMs: number
  tailExtendMs: number
  idleAfterMs: number
}

export interface RhythmSnapshot {
  state: RhythmState
  currentBucketId: string | null
  currentBucket: RhythmBucket | null
}

export interface RhythmPlayer {
  feed(buckets: RhythmBucket[]): void
  snapshot(): RhythmSnapshot
  dispose(): void
}

export function createRhythmPlayer(config: RhythmConfig): RhythmPlayer {
  const queue: RhythmBucket[] = []
  let currentBucket: RhythmBucket | null = null
  let state: RhythmState = 'IDLE'
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  function clearTimer() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function scheduleNext(delayMs: number, next: () => void) {
    clearTimer()
    if (disposed) return
    timer = setTimeout(next, delayMs)
  }

  /**
   * 在 WORKING 状态被定时器触发：决定下一步
   * - 队列里还有桶 → 切到下一桶，进入新一轮 WORKING
   * - 队列空 → 末尾延长 tailExtendMs
   */
  function onWorkingTick() {
    if (disposed) return
    if (queue.length > 0) {
      currentBucket = queue.shift()!
      state = 'WORKING'
      scheduleNext(config.intervalMs, onWorkingTick)
    } else {
      // 末尾延长：等 tailExtendMs 后切到 IDLE
      scheduleNext(config.tailExtendMs, () => {
        if (disposed) return
        currentBucket = null
        state = 'IDLE'
        scheduleNext(config.idleAfterMs, () => {
          if (!disposed) state = 'OFFLINE'
        })
      })
    }
  }

  /**
   * 启动播放器（从 IDLE/OFFLINE 状态被 feed 触发）
   */
  function start() {
    if (disposed) return
    if (queue.length === 0) return
    currentBucket = queue.shift()!
    state = 'WORKING'
    scheduleNext(config.intervalMs, onWorkingTick)
  }

  return {
    feed(buckets) {
      if (disposed) return
      for (const b of buckets) queue.push(b)
      if (state !== 'WORKING' && currentBucket === null && queue.length > 0) {
        // 从 IDLE/OFFLINE 启动
        start()
      }
    },
    snapshot() {
      return { state, currentBucketId: currentBucket?.id ?? null, currentBucket }
    },
    dispose() {
      disposed = true
      clearTimer()
    },
  }
}
