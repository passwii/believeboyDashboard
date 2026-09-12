import { describe, expect, it } from 'vitest'
import contractJson from '../../types/api-generated/insight-contract.json'
import cancelledRunJson from '../../types/api-generated/insight-fixtures/cancelled-run.json'
import failedRunJson from '../../types/api-generated/insight-fixtures/failed-run.json'
import normalRunJson from '../../types/api-generated/insight-fixtures/normal-run.json'
import resumeGapJson from '../../types/api-generated/insight-fixtures/resume-gap.json'
import retryAttemptJson from '../../types/api-generated/insight-fixtures/retry-attempt.json'

/**
 * BLF-1008 Stage 1（I-6）前端契约对齐测试。
 *
 * 只验证 exporter 落盘产物（insight-contract.json + 5 fixture）的
 * fixture/union 对齐：seq、attempt、event id（`{run_id}:{attempt}:{seq}`）
 * 规则，以及坏 JSON 不崩 runner。旧洞察页 / 旧报告 UI / ai-chat-stream-v2
 * 均不在本文件覆盖范围。
 */

interface Envelope {
  schema_version: unknown
  run_id: unknown
  attempt: unknown
  seq: unknown
  type: unknown
  detail?: unknown
  status?: unknown
  checkpoint_seq?: unknown
  content?: unknown
  content_sha256?: unknown
  outputs?: unknown
  error?: unknown
}

interface NarrowedEnvelope extends Envelope {
  run_id: string
  attempt: number
  seq: number
  type: string
}

interface RunFixture {
  run_id: string
  events: Envelope[]
  resume_from?: string
  history_available?: boolean
}

// JSON 落盘产物： widened 推导形状与接口一致，直接注解；下方 expect 做运行时校验。
const normalRun: RunFixture = normalRunJson
const failedRun: RunFixture = failedRunJson
const cancelledRun: RunFixture = cancelledRunJson
const retryAttempt: RunFixture = retryAttemptJson
const resumeGap: RunFixture = resumeGapJson

interface InsightContract {
  schema_version: unknown
  schemas: Record<string, unknown>
  roles: Array<{ canonical_key: string; availability: string }>
  errors: Array<{ code: unknown; http_status: unknown; retryable: unknown }>
  limits: Record<string, unknown>
  cursor: { format: unknown; resume_header: unknown }
}

const contract: InsightContract = contractJson

const FIXTURES: Record<string, RunFixture> = {
  'normal-run': normalRun,
  'failed-run': failedRun,
  'cancelled-run': cancelledRun,
  'retry-attempt': retryAttempt,
  'resume-gap': resumeGap,
}

const EVENT_TYPES: Record<string, true> = {
  snapshot: true,
  status: true,
  'content.delta': true,
  'content.snapshot': true,
  done: true,
  error: true,
  ping: true,
}

/** envelope 收窄：字段缺失或类型不对返回 null，调用方用 expect 断言。 */
function narrowEnvelope(e: Envelope): NarrowedEnvelope | null {
  if (typeof e.run_id !== 'string') return null
  if (typeof e.attempt !== 'number' || !Number.isInteger(e.attempt) || e.attempt < 1) return null
  if (typeof e.seq !== 'number' || !Number.isInteger(e.seq) || e.seq < 1) return null
  if (typeof e.type !== 'string') return null
  return { ...e, run_id: e.run_id, attempt: e.attempt, seq: e.seq, type: e.type }
}

/** 与后端 cursor.format `{run_id}:{attempt}:{seq}` 同语义的测试本地 helper。 */
function eventId(e: NarrowedEnvelope): string {
  return `${e.run_id}:${e.attempt}:${e.seq}`
}

function parseCursor(cursor: string): { runId: string; attempt: number; seq: number } | null {
  const m = /^(.+):(\d+):(\d+)$/.exec(cursor)
  if (!m) return null
  const attempt = Number(m[2])
  const seq = Number(m[3])
  if (!Number.isInteger(attempt) || !Number.isInteger(seq) || attempt < 1 || seq < 1) return null
  return { runId: m[1], attempt, seq }
}

/** runner 侧安全解析：坏 JSON 返回 ok:false，永不抛错。 */
function safeParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

describe('insight contract 落盘产物', () => {
  it('schema_version=1，含 12+ 模型 schema、role manifest、26 个错误码、limits、cursor', () => {
    expect(contract.schema_version).toBe(1)
    for (const name of [
      'InsightRunRequest',
      'InsightRunResponse',
      'InsightRunDetail',
      'InsightError',
      'InsightEvent',
      'SnapshotEvent',
      'StatusEvent',
      'ContentDeltaEvent',
      'ContentSnapshotEvent',
      'DoneEvent',
      'ErrorEvent',
      'PingEvent',
    ]) {
      expect(contract.schemas[name], `missing schema ${name}`).toBeDefined()
    }
    const availabilityByKey: Record<string, string> = {}
    for (const r of contract.roles) availabilityByKey[r.canonical_key] = r.availability
    expect(availabilityByKey['schedule_report_summary.v1']).toBe('active')
    // BLF-1016：广告 / 库存两个 role 已从 reserved 占位提升为可运行。
    expect(availabilityByKey['ad_analysis.v1']).toBe('active')
    expect(availabilityByKey['inventory_health.v1']).toBe('active')
    expect(contract.errors).toHaveLength(26)
    for (const e of contract.errors) {
      expect(typeof e.code).toBe('string')
      expect(Number.isInteger(e.http_status)).toBe(true)
      expect(typeof e.retryable).toBe('boolean')
    }
    expect(contract.cursor.format).toBe('{run_id}:{attempt}:{seq}')
    expect(contract.cursor.resume_header).toBe('Last-Event-ID')
    expect(contract.limits['request_body_max_bytes']).toBeGreaterThan(0)
  })
})

describe('fixture envelope 对齐（5 个 fixture 通用规则）', () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`${name}：事件 envelope 与顶层 run_id 对齐，type 落在 7 类 union 内`, () => {
      expect(fixture.events.length).toBeGreaterThan(0)
      const seen = new Set<string>()
      for (const e of fixture.events) {
        const n = narrowEnvelope(e)
        expect(n, `envelope 收窄失败 ${JSON.stringify(e).slice(0, 120)}`).not.toBeNull()
        if (!n) continue
        expect(n.schema_version).toBe(1)
        expect(n.run_id).toBe(fixture.run_id)
        expect(EVENT_TYPES[n.type], `unknown event type ${n.type}`).toBe(true)
        const id = eventId(n)
        expect(seen.has(id), `duplicate event id ${id}`).toBe(false)
        seen.add(id)
      }
    })
  }
})

describe('normal / retry / resume 序列规则', () => {
  it('normal-run：单 attempt，seq 从 1 连续递增，以 done/completed 收尾', () => {
    const attempts = new Set(normalRun.events.map((e) => e.attempt))
    expect(attempts).toEqual(new Set([1]))
    expect(normalRun.events.map((e) => e.seq)).toEqual(normalRun.events.map((_, i) => i + 1))
    const last = normalRun.events[normalRun.events.length - 1]
    expect(last.type).toBe('done')
    expect(last.status).toBe('completed')
  })

  it('normal-run：content.snapshot checkpoint 与 done 输出互相印证', () => {
    const deltas = normalRun.events.filter((e) => e.type === 'content.delta')
    const snapshot = normalRun.events.find((e) => e.type === 'content.snapshot')
    const done = normalRun.events[normalRun.events.length - 1]
    expect(snapshot).toBeDefined()
    if (!snapshot) return
    expect(snapshot.checkpoint_seq).toBe(deltas[deltas.length - 1].seq)
    expect(done.content_sha256).toBe(snapshot.content_sha256)
    if (done.outputs && typeof done.outputs === 'object' && 'main' in done.outputs) {
      const main = done.outputs.main
      if (main && typeof main === 'object' && 'content_sha256' in main) {
        expect(main.content_sha256).toBe(snapshot.content_sha256)
      }
    }
  })

  it('retry-attempt：attempt 1 以可重试 error 收尾，attempt 2 seq 从 1 重起并完成', () => {
    const first = retryAttempt.events.filter((e) => e.attempt === 1)
    const second = retryAttempt.events.filter((e) => e.attempt === 2)
    expect(first.map((e) => e.seq)).toEqual([1, 2, 3])
    const err = first[first.length - 1]
    expect(err.type).toBe('error')
    if (err.error && typeof err.error === 'object' && 'retryable' in err.error) {
      expect(err.error.retryable).toBe(true)
    } else {
      expect.unreachable('error event 缺少 retryable')
    }
    expect(second[0].seq).toBe(1)
    expect(second.map((e) => e.seq)).toEqual(second.map((_, i) => i + 1))
    expect(second[second.length - 1].type).toBe('done')
  })

  it('resume-gap：resume_from 指向 seq 2 处的 cursor，缺口后从 seq 5 继续', () => {
    expect(typeof resumeGap.resume_from).toBe('string')
    if (typeof resumeGap.resume_from !== 'string') return
    const cursor = parseCursor(resumeGap.resume_from)
    expect(cursor).not.toBeNull()
    expect(cursor?.runId).toBe(resumeGap.run_id)
    expect(cursor).toMatchObject({ attempt: 1, seq: 2 })
    expect(resumeGap.events.map((e) => e.seq)).toEqual([1, 2, 5, 6])
    const resumed = narrowEnvelope(resumeGap.events[2])
    expect(resumed).not.toBeNull()
    if (resumed) expect(eventId(resumed)).toBe(`${resumeGap.run_id}:1:5`)
  })

  it('failed-run / cancelled-run：以 terminal error 收尾，cancelled 不可重试', () => {
    const cases: Record<string, RunFixture> = {
      'failed-run': failedRun,
      'cancelled-run': cancelledRun,
    }
    for (const [name, fixture] of Object.entries(cases)) {
      const last = fixture.events[fixture.events.length - 1]
      expect(last.type).toBe('error')
      if (last.error && typeof last.error === 'object' && 'retryable' in last.error) {
        expect(last.error.retryable).toBe(name !== 'cancelled-run')
      } else {
        expect.unreachable(`${name} error event 缺少 retryable`)
      }
    }
  })
})

describe('坏输入不崩 runner', () => {
  it('非法 JSON / 截断 fixture 安全失败，不抛错', () => {
    expect(safeParseJson('{not json')).toEqual({ ok: false })
    expect(safeParseJson('')).toEqual({ ok: false })
    expect(safeParseJson(JSON.stringify(normalRunJson).slice(0, -10)).ok).toBe(false)
    expect(safeParseJson(JSON.stringify(normalRunJson)).ok).toBe(true)
  })

  it('非法 cursor 串返回 null，不抛错', () => {
    expect(parseCursor('garbage')).toBeNull()
    expect(parseCursor('run:0:1')).toBeNull()
    expect(parseCursor('run:1:0')).toBeNull()
    expect(parseCursor('run:x:1')).toBeNull()
    expect(parseCursor('')).toBeNull()
    const first = narrowEnvelope(normalRun.events[0])
    expect(first).not.toBeNull()
    if (first) expect(parseCursor(eventId(first))).toMatchObject({ attempt: 1, seq: 1 })
  })
})
