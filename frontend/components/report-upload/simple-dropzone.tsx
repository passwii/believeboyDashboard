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
        // BLF-893：dropzone 终端化——零圆角、term 令牌、slate 拖入态走 term-accent。
        'relative flex flex-col items-center justify-center gap-3 rounded-none border-2 border-dashed border-term-border bg-term-panel px-6 py-10 text-center transition-[border-color,background-color] duration-[var(--duration-quick)] cursor-pointer hover:border-term-border-strong',
        dragActive && 'border-term-accent bg-term-hover',
        className
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
        <div className="flex h-12 w-12 items-center justify-center rounded-none border border-term-border bg-term-bg">
          <FileUp className="h-5 w-5 text-term-muted" />
        </div>
        <div className="space-y-1">
          <p className="font-mono text-xs leading-5 text-term-text">拖拽文件到这里，或点击选择</p>
          <p className="font-mono text-[11px] leading-4 text-term-muted">支持 txt、csv、xlsx</p>
        </div>
      </label>
      {recognizing ? (
        <div className="absolute inset-x-0 bottom-3 flex items-center justify-center gap-2 font-mono text-[11px] leading-4 text-term-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在识别...
        </div>
      ) : null}
    </div>
  )
}
