/**
 * Daily Report Page - Utilities
 * 销售日报页面的工具函数
 */

import type { StatusMeta, UploadStateItem, UploadType } from './index'

/**
 * 获取状态元数据
 */
export function getStatusMeta(state: UploadStateItem): StatusMeta {
  if (state.status === 'success') {
    return { text: '上传完成', progress: 100, tone: 'success' }
  }
  if (state.status === 'uploading') {
    return { text: '上传中', progress: 68, tone: 'loading' }
  }
  if (state.status === 'error') {
    return { text: '上传失败', progress: 100, tone: 'error' }
  }
  if (state.selectedFile) {
    return { text: '已选择文件', progress: 36, tone: 'loading' }
  }
  return { text: '待处理', progress: 18, tone: 'neutral' }
}

/**
 * 检查是否为上传类型
 */
export function isUploadType(value: string): value is UploadType {
  return value === 'sales_report' || value === 'ad_report' || value === 'inventory_report'
}

/**
 * 验证文件格式
 */
export function validateFile(file: File, key: UploadType): boolean {
  const fileName = file.name.toLowerCase()
  if (key === 'ad_report') {
    return fileName.endsWith('.xlsx')
  }
  return fileName.endsWith('.txt')
}

/**
 * 获取昨天的日期字符串
 */
export function yesterdayDateString(): string {
  const date = new Date()
  date.setDate(date.getDate() - 1)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 从响应头提取文件名
 */
export function extractFilenameFromHeader(contentDisposition: string | null): string | null {
  if (!contentDisposition) {
    return null
  }
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1])
  }
  const basicMatch = contentDisposition.match(/filename="?([^"]+)"?/i)
  return basicMatch?.[1] ?? null
}
