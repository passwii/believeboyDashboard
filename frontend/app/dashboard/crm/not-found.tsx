import Link from 'next/link'
import { Construction } from 'lucide-react'

export default function CrmNotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <Construction className="h-12 w-12 text-muted-foreground" aria-hidden="true" />
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">CRM 页面不存在</h2>
        <p className="text-sm text-muted-foreground">
          你访问的 CRM 路径未定义。回到客户列表继续操作。
        </p>
      </div>
      <Link
        href="/dashboard/crm/customers"
        className="inline-flex h-9 items-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
      >
        返回客户列表
      </Link>
    </div>
  )
}
