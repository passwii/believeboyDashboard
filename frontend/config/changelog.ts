export interface ChangeLogEntry {
  id: string
  date: string
  version?: string
  title: string
  content: string
  highlights?: string[]
}

/**
 * 更新日志
 *
 * 使用说明：
 * 1. 每次发布新功能后，在数组头部添加新条目
 * 2. id 格式：'YYYY-MM-DD-序号'，如 '2026-04-03-001'
 * 3. date 格式：'YYYY-MM-DD'
 * 4. content 支持多段落，用 \n\n 分隔
 * 5. highlights 为可选的重点列表
 */
export const changeLog: ChangeLogEntry[] = [
  {
    id: '2026-04-03-001',
    date: '2026-04-03',
    version: 'v1.2.0',
    title: '新增功能更新通知系统',
    content:
      '本次更新包含以下内容：\n\n1. 新增更新日志弹窗通知\n2. 用户可以在下次打开页面时看到最新功能介绍\n3. 优化了整体用户体验',
    highlights: ['新增 changelog 弹窗', '支持查看历史更新', '自动检测未读更新'],
  },
]