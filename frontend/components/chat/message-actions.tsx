'use client'

import { useState } from 'react'
import { Copy, Check, RefreshCw, Pencil, Trash2 } from 'lucide-react'

interface MessageActionsProps {
  role: 'user' | 'assistant'
  content: string
  onRegenerate?: () => void
  onEdit?: () => void
  onDelete?: () => void
}

export function MessageActions({
  role,
  content,
  onRegenerate,
  onEdit,
  onDelete,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      const el = document.createElement('textarea')
      el.value = content
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity duration-[var(--duration-quick)]">
      <button
        type="button"
        onClick={handleCopy}
        className="flex items-center justify-center size-9 sm:size-7 rounded-lg transition-all duration-150 active:scale-95 touch-manipulation text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:text-[#5a5a5f] dark:hover:text-white dark:hover:bg-white/[0.06]"
        aria-label={copied ? '已复制' : '复制'}
      >
        {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
      </button>

      {role === 'user' && onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="flex items-center justify-center size-9 sm:size-7 rounded-lg transition-all duration-150 active:scale-95 touch-manipulation text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:text-[#5a5a5f] dark:hover:text-white dark:hover:bg-white/[0.06]"
          aria-label="编辑"
        >
          <Pencil className="size-3.5" />
        </button>
      )}

      {role === 'assistant' && onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          className="flex items-center justify-center size-9 sm:size-7 rounded-lg transition-all duration-150 active:scale-95 touch-manipulation text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:text-[#5a5a5f] dark:hover:text-white dark:hover:bg-white/[0.06]"
          aria-label="重新生成"
        >
          <RefreshCw className="size-3.5" />
        </button>
      )}

      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          className="flex items-center justify-center size-9 sm:size-7 rounded-lg transition-all duration-150 active:scale-95 touch-manipulation text-slate-400 hover:text-red-500 hover:bg-red-50 dark:text-[#5a5a5f] dark:hover:text-red-400 dark:hover:bg-red-400/[0.06]"
          aria-label="删除"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  )
}
