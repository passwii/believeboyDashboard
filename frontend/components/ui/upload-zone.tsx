'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { type DragEvent, type ChangeEvent } from 'react'
import { FileUp, Loader2, X, FileText, Image as ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './button'

interface UploadZoneProps {
  accept?: string
  maxSize?: number // MB
  onUpload: (file: File) => void | Promise<void>
  disabled?: boolean
  className?: string
  /** 上传中的状态描述 */
  uploadingText?: string
  /** 是否显示内置预览区域（父组件自行管理预览时设为 false） */
  showPreview?: boolean
}

export function UploadZone({
  accept = 'image/*,.pdf,.xlsx,.xls',
  maxSize = 10,
  onUpload,
  disabled = false,
  className,
  uploadingText = '上传中...',
  showPreview = true,
}: UploadZoneProps) {
  const [isDragActive, setIsDragActive] = useState(false)
  const [isPasteActive, setIsPasteActive] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewType, setPreviewType] = useState<'image' | 'pdf' | 'other' | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const dropzoneRef = useRef<HTMLDivElement>(null)

  // 处理文件：校验、预览、上传
  const processFile = useCallback(
    async (file: File) => {
      // 检查文件大小
      if (file.size > maxSize * 1024 * 1024) {
        setErrorMsg(`文件大小不能超过 ${maxSize}MB`)
        setTimeout(() => setErrorMsg(null), 3000)
        return
      }

      // 生成预览
      if (showPreview) {
        if (file.type.startsWith('image/')) {
          const url = URL.createObjectURL(file)
          setPreview(url)
          setPreviewType('image')
        } else if (file.type === 'application/pdf') {
          setPreview(file.name)
          setPreviewType('pdf')
        } else {
          setPreview(file.name)
          setPreviewType('other')
        }
      }

      // 上传
      setIsUploading(true)
      try {
        await onUpload(file)
      } finally {
        setIsUploading(false)
      }
    },
    [maxSize, onUpload]
  )

  // 点击上传按钮
  const handleButtonClick = () => {
    inputRef.current?.click()
  }

  // 点击虚线框激活粘贴模式
  const handleDropzoneClick = () => {
    if (isUploading || disabled) return
    setIsPasteActive((v) => !v)
  }

  // 文件选择（点击或拖拽）
  const handleFileSelect = async (file: File) => {
    setErrorMsg(null)
    await processFile(file)
  }

  // 输入变化
  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      void handleFileSelect(file)
    }
    // 重置 input 以便再次选择相同文件
    e.target.value = ''
  }

  // 拖拽
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (!disabled && !isUploading) setIsDragActive(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragActive(false)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragActive(false)
    if (disabled || isUploading) return

    const file = e.dataTransfer.files?.[0]
    if (file) {
      setErrorMsg(null)
      void handleFileSelect(file)
    }
  }

  // 粘贴监听
  useEffect(() => {
    if (!isPasteActive || disabled || isUploading) return

    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return

      for (const item of items) {
        const acceptTypes = accept.split(',').map((t) => t.trim().toLowerCase())
        const matchImage = acceptTypes.some(
          (t) => t === 'image/*' || item.type.startsWith('image/')
        )
        const matchFile = acceptTypes.includes(item.type.toLowerCase())

        if (matchImage || matchFile) {
          e.preventDefault()
          const file = item.getAsFile()
          if (file) {
            setErrorMsg(null)
            void handleFileSelect(file)
          }
          break
        }
      }
    }

    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [isPasteActive, disabled, isUploading, accept])

  // 清理预览 URL
  const clearPreview = () => {
    if (previewType === 'image' && preview) {
      URL.revokeObjectURL(preview)
    }
    setPreview(null)
    setPreviewType(null)
    setIsPasteActive(false)
  }

  return (
    <div className={cn('space-y-3', className)}>
      {/* 上传区域 */}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={handleButtonClick}
          disabled={disabled || isUploading}
          className="shrink-0"
        >
          <FileUp className="mr-2 h-4 w-4" />
          上传文件
        </Button>

        {/* 虚线框区域 */}
        <div
          ref={dropzoneRef}
          onClick={handleDropzoneClick}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            'flex flex-1 cursor-pointer items-center justify-center rounded-lg border-2 border-dashed px-4 py-5 transition-colors duration-200',
            isDragActive
              ? 'border-slate-400/60 bg-slate-50 dark:border-slate-500/50 dark:bg-slate-800/25'
              : isPasteActive
                ? 'border-blue-400 bg-blue-50 dark:border-blue-500/50 dark:bg-blue-900/20'
                : 'border-border/70 bg-[hsl(var(--surface-subtle))] hover:border-slate-300 dark:border-border/90 dark:hover:border-slate-600',
            (disabled || isUploading) && 'cursor-not-allowed opacity-60'
          )}
        >
          {isUploading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {uploadingText}
            </div>
          ) : isPasteActive ? (
            <p className="text-sm text-blue-600 dark:text-blue-400">
              <span className="font-medium">粘贴模式已激活</span>
              <span className="ml-2 text-muted-foreground">— 按 Ctrl+V 粘贴图片或文件</span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">点击此处激活粘贴上传，或拖拽文件到这里</p>
          )}
        </div>
      </div>

      {/* 错误提示 */}
      {errorMsg ? <p className="text-sm text-rose-600 dark:text-rose-400">{errorMsg}</p> : null}

      {/* 预览区域 */}
      {showPreview && preview ? (
        <div className="relative rounded-lg border border-border/70 bg-[hsl(var(--surface-subtle))] p-3">
          <button
            type="button"
            onClick={clearPreview}
            className="absolute right-2 top-2 rounded-full bg-slate-200/80 p-1 hover:bg-slate-300 dark:bg-slate-700/80 dark:hover:bg-slate-600"
          >
            <X className="h-3.5 w-3.5" />
          </button>

          {previewType === 'image' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="预览" className="max-h-48 w-auto rounded-md object-contain" />
          ) : (
            <div className="flex items-center gap-3 py-2">
              {previewType === 'pdf' ? (
                <FileText className="h-8 w-8 text-rose-500" />
              ) : (
                <FileText className="h-8 w-8 text-slate-400" />
              )}
              <span className="text-sm text-foreground">{preview}</span>
            </div>
          )}
        </div>
      ) : null}

      {/* 隐藏的文件输入 */}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleInputChange}
        className="hidden"
      />
    </div>
  )
}
