'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchEmployeeTasks } from '@/lib/digital-employee-api'
import { aggregateTasks, type RawTask } from '@/lib/digital-employee/aggregator'
import {
  createRhythmPlayer,
  type RhythmBucket,
  type RhythmPlayer,
  type RhythmSnapshot,
} from '@/lib/digital-employee/rhythm-player'
import { renderState } from '@/lib/digital-employee/persona-templates'
import { ArrowRight, Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface PersonifiedPlayerProps {
  employeeId: number
  employeeName: string
  pollIntervalMs?: number
  lookbackMinutes?: number
}

const DEFAULT_RHYTHM = {
  intervalMs: 3000,
  tailExtendMs: 12000,
  idleAfterMs: 30000,
}

export function PersonifiedPlayer({
  employeeId,
  employeeName,
  pollIntervalMs = 15000,
}: PersonifiedPlayerProps) {
  const [snapshot, setSnapshot] = useState<RhythmSnapshot>({
    state: 'IDLE',
    currentBucketId: null,
    currentBucket: null,
  })
  const [isPaused, setIsPaused] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const playerRef = useRef<RhythmPlayer | null>(null)
  const consumedIdsRef = useRef<Set<string>>(new Set())

  // 初始化播放器 + 订阅 snapshot
  useEffect(() => {
    const p = createRhythmPlayer(DEFAULT_RHYTHM)
    playerRef.current = p
    const interval = setInterval(() => {
      setSnapshot(p.snapshot())
    }, 200)
    return () => {
      clearInterval(interval)
      p.dispose()
      playerRef.current = null
    }
  }, [])

  // 拉取 tasks 并喂给播放器
  useEffect(() => {
    if (isPaused) return

    async function poll() {
      try {
        const { items } = await fetchEmployeeTasks(employeeId)
        const tasks = items as RawTask[]
        const allBuckets = aggregateTasks(tasks)
        const newBuckets = allBuckets.filter(
          (b) => !consumedIdsRef.current.has(b.id),
        )
        for (const b of newBuckets) consumedIdsRef.current.add(b.id)
        if (newBuckets.length > 0) {
          playerRef.current?.feed(newBuckets)
        }
      } catch (err) {
        console.warn('[PersonifiedPlayer] poll failed', err)
      } finally {
        setIsLoading(false)
      }
    }

    void poll()
    const interval = setInterval(poll, pollIntervalMs)
    return () => clearInterval(interval)
  }, [employeeId, pollIntervalMs, isPaused])

  const text = useMemo(
    () => renderState(snapshot.state, { bucket: snapshot.currentBucket, employeeName }),
    [snapshot, employeeName],
  )

  const stateStyle = STATE_STYLES[snapshot.state]

  return (
    <div className="rounded-2xl border bg-gradient-to-br from-card to-card/60 p-8">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'flex h-2.5 w-2.5 rounded-full',
              stateStyle.dot,
              snapshot.state === 'WORKING' && 'animate-pulse',
            )}
          />
          <span className={cn('text-xs font-medium uppercase tracking-wider', stateStyle.text)}>
            {stateStyle.label}
          </span>
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setIsPaused((v) => !v)}
          className="h-8 w-8"
          title={isPaused ? '继续' : '暂停'}
        >
          {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
        </Button>
      </div>

      <div className="min-h-[120px] flex items-center justify-center text-center">
        {isLoading ? (
          <div className="text-muted-foreground text-sm animate-pulse">正在加载任务历史…</div>
        ) : (
          <p
            key={snapshot.currentBucketId ?? snapshot.state}
            className="text-2xl md:text-3xl font-medium leading-relaxed animate-in fade-in slide-in-from-bottom-2 duration-300"
          >
            {text}
          </p>
        )}
      </div>

      {snapshot.state === 'WORKING' && (
        <div className="mt-6 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-blue-500 to-transparent animate-shimmer" />
        </div>
      )}

      {snapshot.currentBucket && (
        <div className="mt-4 flex items-center justify-center gap-3 text-xs text-muted-foreground flex-wrap">
          <span>{snapshot.currentBucket.projectName}</span>
          <ArrowRight className="h-3 w-3" />
          <span>{snapshot.currentBucket.reportLabel}</span>
          <span>·</span>
          <span>{snapshot.currentBucket.dateRange}</span>
          {snapshot.currentBucket.eventCount > 1 && (
            <>
              <span>·</span>
              <span>共 {snapshot.currentBucket.eventCount} 份</span>
            </>
          )}
        </div>
      )}
    </div>
  )
}

const STATE_STYLES: Record<
  RhythmSnapshot['state'],
  { label: string; dot: string; text: string }
> = {
  IDLE: {
    label: '待命',
    dot: 'bg-muted-foreground',
    text: 'text-muted-foreground',
  },
  WORKING: {
    label: '工作中',
    dot: 'bg-blue-500',
    text: 'text-blue-600 dark:text-blue-400',
  },
  OFFLINE: {
    label: '下班',
    dot: 'bg-muted',
    text: 'text-muted',
  },
}

// Ensure unused import is referenced (RhythmBucket is used in type alias)
export type { RhythmBucket }
