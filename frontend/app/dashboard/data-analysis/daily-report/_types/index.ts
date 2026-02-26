/**
 * Daily Report Page - Type Definitions
 * 销售日报页面的所有类型定义
 */

/** 上传文件类型 */
export type UploadType = 'sales_report' | 'ad_report' | 'inventory_report'

/** 上传状态 */
export type UploadStatus = 'idle' | 'uploading' | 'success' | 'error'

/** 提交状态 */
export type SubmitStatus = 'idle' | 'submitting' | 'success' | 'error'

/** 状态元数据 */
export interface StatusMeta {
  text: string
  progress: number
  tone: 'neutral' | 'loading' | 'success' | 'error'
}

/** 上传文件元信息 */
export interface UploadFileMeta {
  filePath: string
  filename: string
  originalFilename: string
}

/** 上传状态项 */
export interface UploadStateItem {
  status: UploadStatus
  selectedFile: File | null
  selectedReason: string | null
  uploaded: UploadFileMeta | null
  error: string | null
}

/** 提交状态 */
export interface SubmitState {
  status: SubmitStatus
  message: string | null
  filename: string | null
}

/** 项目选项 */
export interface ProjectOption {
  name: string
}

/** 文件配置 */
export interface FileConfig {
  key: UploadType
  title: string
  description: string
  accept: string
}

/** 上传状态记录 */
export type UploadState = Record<UploadType, UploadStateItem>

/** 动画变体 */
export interface AnimationVariants {
  hidden: Record<string, number>
  show: Record<string, unknown>
  exit?: Record<string, unknown>
}

/** 组件通用Props */
export interface BaseComponentProps {
  className?: string
  children?: React.ReactNode
}

/** 上传行组件Props */
export interface UploadRowProps {
  fileItem: FileConfig
  state: UploadStateItem
  canUpload: boolean
  reduceMotion: boolean
  onPickFile: (key: UploadType, file: File | null, reason?: string) => void
  onUpload: (key: UploadType) => Promise<void>
  onReset: (key: UploadType) => void
}

/** 进度轨道组件Props */
export interface UploadProgressRailProps {
  meta: StatusMeta
  reduceMotion: boolean
}

/** 状态徽章组件Props */
export interface StatusPillProps {
  status: UploadStatus
}
