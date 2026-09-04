import { StatusBackButton } from '@/components/system/status-back-button'
import { StatusHomeAction, StatusPageShell } from '@/components/system/status-page-shell'

export default function DashboardNotFoundPage() {
  return (
    <StatusPageShell
      code="404"
      title="当前功能页无法访问"
      description="这个看板页面不存在，或者你访问的地址已经失效。请返回首页重新进入对应模块，或联系管理员确认菜单配置。"
      tone="warning"
      compact
      primaryAction={<StatusHomeAction href="/dashboard" />}
      secondaryAction={<StatusBackButton />}
    />
  )
}
