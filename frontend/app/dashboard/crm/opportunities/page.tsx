import { Construction } from 'lucide-react'

export default function OpportunitiesPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
      <Construction className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
      <h1 className="text-xl font-semibold tracking-tight">商机管理</h1>
      <p className="text-sm text-muted-foreground">Phase 3 即将上线（Day 8-9，只读列表）</p>
    </div>
  )
}
