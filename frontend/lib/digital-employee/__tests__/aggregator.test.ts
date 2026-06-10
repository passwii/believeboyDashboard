import { describe, it, expect } from 'vitest'
import { aggregateTasks, type RawTask } from '../aggregator'

function rawTask(overrides: Partial<RawTask> = {}): RawTask {
  return {
    id: 'task-1',
    task_id: 'aru-1-payment',
    task_name: '润茗/Payment Report',
    task_type: 'payment_report',
    status: 'SUCCEEDED',
    progress_percent: 100,
    current_step: '入库完成',
    started_at: '2026-06-10T10:00:00Z',
    ended_at: '2026-06-10T10:00:05Z',
    metadata_json: { project_name: '润茗', report_label: 'Payment Report', country: 'US', row_count: 100, detected_date_range: '06-05' },
    ...overrides,
  }
}

describe('aggregateTasks', () => {
  it('空输入返回空数组', () => {
    expect(aggregateTasks([])).toEqual([])
  })

  it('单条任务生成一个桶', () => {
    const buckets = aggregateTasks([rawTask()])
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toMatchObject({
      projectName: '润茗',
      reportType: 'payment_report',
      reportLabel: 'Payment Report',
      status: 'SUCCEEDED',
      eventCount: 1,
      rowCountTotal: 100,
    })
  })

  it('同 project × report_type 的多条任务合并为一个桶', () => {
    const buckets = aggregateTasks([
      rawTask({ id: '1', metadata_json: { project_name: '润茗', report_label: 'Payment Report', country: 'US', row_count: 100, detected_date_range: '06-05' } }),
      rawTask({ id: '2', metadata_json: { project_name: '润茗', report_label: 'Payment Report', country: 'US', row_count: 200, detected_date_range: '06-06' } }),
    ])
    expect(buckets).toHaveLength(1)
    expect(buckets[0].eventCount).toBe(2)
    expect(buckets[0].rowCountTotal).toBe(300)
  })

  it('不同 project 拆成不同桶', () => {
    const buckets = aggregateTasks([
      rawTask({ id: '1', metadata_json: { project_name: '润茗', report_label: 'Payment Report', country: 'US', row_count: 100, detected_date_range: '06-05' } }),
      rawTask({ id: '2', metadata_json: { project_name: '弥森', report_label: 'Payment Report', country: 'US', row_count: 50, detected_date_range: '06-05' } }),
    ])
    expect(buckets).toHaveLength(2)
  })

  it('按 firstOccurredAt 升序排序', () => {
    const buckets = aggregateTasks([
      rawTask({ id: '1', started_at: '2026-06-10T10:01:00Z', metadata_json: { project_name: 'B', report_label: 'X', country: 'US', row_count: 1, detected_date_range: '06-05' } }),
      rawTask({ id: '2', started_at: '2026-06-10T10:00:00Z', metadata_json: { project_name: 'A', report_label: 'X', country: 'US', row_count: 1, detected_date_range: '06-05' } }),
    ])
    expect(buckets[0].projectName).toBe('A')
    expect(buckets[1].projectName).toBe('B')
  })

  it('粒度自适应：单 project 桶事件数 >20 则合并为"多项目"桶', () => {
    // 5 个 project，每个 25 条任务 → 单 project 桶事件数 >20 → 合并为 1 个"多项目"桶
    const projects = ['A', 'B', 'C', 'D', 'E']
    const tasks: RawTask[] = []
    projects.forEach((p, pi) => {
      for (let i = 0; i < 25; i++) {
        tasks.push(
          rawTask({
            id: `${pi}-${i}`,
            metadata_json: { project_name: p, report_label: 'Payment Report', country: 'US', row_count: 10, detected_date_range: '06-05' },
          }),
        )
      }
    })
    const buckets = aggregateTasks(tasks)
    expect(buckets).toHaveLength(1)
    expect(buckets[0].projectName).toBe('多项目')
    expect(buckets[0].eventCount).toBe(125)
  })

  it('桶状态：success 占比 ≥80% 算 success，否则按最高级别（failed > running > pending）', () => {
    const buckets = aggregateTasks([
      rawTask({ id: '1', status: 'SUCCEEDED', metadata_json: { project_name: 'A', report_label: 'X', country: 'US', row_count: 1, detected_date_range: '06-05' } }),
      rawTask({ id: '2', status: 'SUCCEEDED', metadata_json: { project_name: 'A', report_label: 'X', country: 'US', row_count: 1, detected_date_range: '06-05' } }),
      rawTask({ id: '3', status: 'FAILED', metadata_json: { project_name: 'A', report_label: 'X', country: 'US', row_count: 1, detected_date_range: '06-05' } }),
    ])
    expect(buckets[0].status).toBe('FAILED')  // 2/3 = 67% < 80%
  })

  it('缺失 metadata_json 时 projectName 用 _global', () => {
    const buckets = aggregateTasks([rawTask({ metadata_json: null })])
    expect(buckets[0].projectName).toBe('_global')
  })
})
