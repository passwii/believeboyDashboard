import { StatusBackButton } from '@/components/system/status-back-button'
import { StatusHomeAction, StatusPageShell } from '@/components/system/status-page-shell'

export default function NotFoundPage() {
  return (
    <StatusPageShell
      code="404"
      title="你访问的页面不存在"
      description="当前链接可能已失效、地址填写错误，或者该页面已经被移动。你可以返回首页继续操作，或回到上一步重新选择入口。"
      tone="warning"
      primaryAction={<StatusHomeAction />}
      secondaryAction={<StatusBackButton />}
    />
  )
}
