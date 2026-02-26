/**
 * Daily Report Page - Constants
 * 销售日报页面的常量配置
 */

import type { FileConfig, UploadState, UploadType } from './_types'

/** API配置 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''
export const API_KEY = process.env.NEXT_PUBLIC_BACKEND_API_KEY ?? ''

/** 认证头 */
export function authHeaders() {
  return API_KEY ? { 'X-API-Key': API_KEY } : {}
}

/** 文件配置 */
export const FILE_CONFIG: FileConfig[] = [
  {
    key: 'sales_report',
    title: '销售报表',
    description: '仅支持 .txt，首行建议包含 amazon-order-id',
    accept: '.txt,text/plain',
  },
  {
    key: 'ad_report',
    title: '广告报表',
    description: '仅支持 .xlsx，文件名建议包含 ad/广告/推广',
    accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  {
    key: 'inventory_report',
    title: '库存报告',
    description: '仅支持 .txt，首行建议包含 snapshot-date',
    accept: '.txt,text/plain',
  },
]

/** 上传类型数组 */
export const UPLOAD_TYPES: UploadType[] = ['sales_report', 'ad_report', 'inventory_report']

/** 初始上传状态 */
export function initialUploadState(): UploadState {
  return {
    sales_report: {
      status: 'idle',
      selectedFile: null,
      selectedReason: null,
      uploaded: null,
      error: null,
    },
    ad_report: {
      status: 'idle',
      selectedFile: null,
      selectedReason: null,
      uploaded: null,
      error: null,
    },
    inventory_report: {
      status: 'idle',
      selectedFile: null,
      selectedReason: null,
      uploaded: null,
      error: null,
    },
  }
}
