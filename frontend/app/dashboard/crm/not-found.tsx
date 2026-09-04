import Link from 'next/link'
import { Construction } from 'lucide-react'

export default function CrmNotFound() {
  return (
    // BLF-837：终端规格占位页（零圆角、term 边界、mono 标签）
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
      <Construction className="h-10 w-10 text-term-faint" strokeWidth={1.75} aria-hidden="true" />
      <div className="space-y-1.5">
        <h2 className="font-mono text-sm uppercase tracking-wider text-term-muted">
          CRM 页面不存在
        </h2>
        <p className="text-sm text-term-faint">
          你访问的 CRM 路径未定义。回到客户列表继续操作。
        </p>
      </div>
      <Link
        href="/dashboard/crm/customers"
        className="inline-flex h-9 items-center rounded-none border border-term-border bg-term-panel px-2 font-mono text-xs text-term-muted transition-colors hover:border-term-border-strong hover:text-term-text"
      >
        返回客户列表
      </Link>
    </div>
  )
}
