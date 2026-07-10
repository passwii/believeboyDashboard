import { Construction } from 'lucide-react'

export default function SettingsPage() {
 return (
 <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
 <Construction className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
 <h1 className="text-xl font-semibold tracking-tight">CRM 设置</h1>
 <p className="text-sm text-muted-foreground">未开放 · V2 启用（自定义字段、阶段、来源等）</p>
 </div>
 )
}