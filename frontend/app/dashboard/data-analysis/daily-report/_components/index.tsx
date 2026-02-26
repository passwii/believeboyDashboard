/**
 * Daily Report Page - UI Components
 * 销售日报页面的UI子组件
 */

'use client'

import { motion } from 'framer-motion'
import { Check, Loader2, Upload, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type {
  FileConfig,
  StatusMeta,
  StatusPillProps,
  UploadProgressRailProps,
  UploadRowProps,
  UploadStateItem,
} from '../_types'

/**
 * 状态徽章组件
 */
export function StatusPill({ status }: StatusPillProps) {
  if (status === 'success') {
    return (
      <Badge className="border border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300 hover:bg-emerald-50">
        <Check className="mr-1 h-3.5 w-3.5" />
        已上传
      </Badge>
    )
  }

  if (status === 'error') {
    return (
      <Badge variant="destructive" className="border border-rose-300 bg-rose-50 text-rose-700 dark:bg-rose-900/50 dark:text-rose-300 hover:bg-rose-50">
        <X className="mr-1 h-3.5 w-3.5" />
        失败
      </Badge>
    )
  }

  if (status === 'uploading') {
    return (
      <Badge className="border border-blue-300 bg-blue-50 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 hover:bg-blue-50">
        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        上传中
      </Badge>
    )
  }

  return <Badge variant="secondary">待上传</Badge>
}

/**
 * 上传进度轨道组件
 */
export function UploadProgressRail({ meta, reduceMotion }: UploadProgressRailProps) {
  const toneClasses = {
    neutral: 'bg-foreground/40',
    loading: 'bg-blue-500',
    success: 'bg-emerald-500',
    error: 'bg-rose-500',
  }

  const trackClasses = {
    neutral: 'bg-muted',
    loading: 'bg-blue-100',
    success: 'bg-emerald-100',
    error: 'bg-rose-100',
  }

  return (
    <div className={cn('h-2 w-full overflow-hidden rounded-full', trackClasses[meta.tone])}>
      <motion.div
        className={cn('h-full rounded-full', toneClasses[meta.tone])}
        initial={{ width: 0 }}
        animate={{ width: `${meta.progress}%` }}
        transition={
          reduceMotion
            ? { duration: 0.1 }
            : { duration: 0.28, ease: [0.22, 1, 0.36, 1] }
        }
      />
    </div>
  )
}

/**
 * 上传行组件
 */
export function UploadRow({
  fileItem,
  state,
  canUpload,
  reduceMotion,
  onPickFile,
  onUpload,
  onReset,
}: UploadRowProps) {
  const toneClasses =
    state.status === 'success'
      ? 'border-emerald-200/90 bg-emerald-50/60 dark:bg-emerald-900/40'
      : state.status === 'error'
        ? 'border-rose-200/90 bg-rose-50/60 dark:bg-rose-900/40'
        : state.status === 'uploading'
          ? 'border-blue-200/90 bg-blue-50/70 dark:bg-blue-900/50'
          : 'border-border bg-card'

  return (
    <motion.div
      layout
      whileHover={reduceMotion ? undefined : { y: -2 }}
      transition={reduceMotion ? { duration: 0.1 } : { duration: 0.2, ease: 'easeOut' }}
      className={cn('rounded-xl border p-4 shadow-sm', toneClasses)}
    >
      <div className="grid gap-3 xl:grid-cols-[180px_1fr_auto] xl:items-center">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">{fileItem.title}</p>
          <p className="text-xs leading-relaxed text-muted-foreground">{fileItem.description}</p>
          {state.selectedReason ? (
            <p className="text-[11px] text-blue-600 dark:text-blue-300">{state.selectedReason}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Input
            type="file"
            accept={fileItem.accept}
            onChange={(event) => onPickFile(fileItem.key, event.target.files?.[0] ?? null)}
            disabled={state.status === 'uploading'}
            className="bg-background"
          />
          <p className="truncate text-xs text-muted-foreground">
            {state.uploaded?.originalFilename ?? state.selectedFile?.name ?? '尚未选择文件'}
          </p>
        </div>

        <div className="flex items-center gap-2 xl:justify-end">
          <StatusPill status={state.status} />
          <Button
            type="button"
            size="sm"
            onClick={() => void onUpload(fileItem.key)}
            disabled={!canUpload || !state.selectedFile || state.status === 'uploading'}
            className="min-w-20"
          >
            {state.status === 'uploading' ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-1 h-4 w-4" />
            )}
            上传
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onReset(fileItem.key)}
            disabled={state.status === 'uploading'}
            className="min-w-20"
          >
            重置
          </Button>
        </div>
      </div>
    </motion.div>
  )
}
