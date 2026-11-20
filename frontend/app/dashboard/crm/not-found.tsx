import { StatusHomeAction, StatusPageShell } from '@/components/system/status-page-shell'

export default function CrmNotFound() {
  return (
    <StatusPageShell
      code="404"
      kind="not-found"
      headingLevel="h2"
      title="CRM 页面不存在"
      description="你访问的 CRM 路径未定义。回到客户列表继续操作。"
      tone="warning"
      compact
      primaryAction={
        <StatusHomeAction href="/dashboard/crm/customers">
          返回客户列表
        </StatusHomeAction>
      }
    />
  )
}
