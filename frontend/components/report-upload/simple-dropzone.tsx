'use client'

import { type DragEvent, type ChangeEvent } from 'react'
import { FileUp, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

type Props = {
  dragActive: boolean
  recognizing: boolean
  onDrop: (event: DragEvent<HTMLDivElement>) => void
  onDragOver: (event: DragEvent<HTMLDivElement>) => void
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void
  onPickFiles: (event: ChangeEvent<HTMLInputElement>) => void
  /** 自定义 input id，避免多个 dropzone 同时存在时冲突 */
  inputId?: string
  className?: string
}

export function SimpleDropzone({
  dragActive,
  recognizing,
  onDrop,
  onDragOver,
  onDragLeave,
  onPickFiles,
  inputId = 'simple-dropzone-input',
  className,
}: Props) {
  return (
    <div
      className={cn(
        'relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-[border-color,background-color] duration-200 cursor-pointer',
        dragActive
          ? 'border-slate-400/60 bg-slate-50 dark:border-slate-500/50 dark:bg-slate-800/25'
          : 'border-border/70 bg-[hsl(var(--surface-subtle))] hover:border-slate-300 dark:border-border/90 dark:hover:border-slate-600',
        className,
      )}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <input
        id={inputId}
        type="file"
        multiple
        className="hidden"
        accept=".txt,.csv,.xlsx"
        onChange={onPickFiles}
      />
      <label
        htmlFor={inputId}
        className="flex w-full cursor-pointer flex-col items-center justify-center gap-3"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-border/50 bg-[hsl(var(--surface-soft))]">
          <FileUp className="h-5 w-5 text-slate-500 dark:text-slate-400" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">拖拽文件到这里，或点击选择</p>
          <p className="text-xs text-muted-foreground">支持 txt、csv、xlsx</p>
        </div>
      </label>
      {recognizing ? (
        <div className="absolute inset-x-0 bottom-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在识别...
        </div>
      ) : null}
    </div>
  )
}
