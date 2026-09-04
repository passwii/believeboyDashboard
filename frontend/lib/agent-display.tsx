'use client'

/**
 * Agent 日志面板共用展示 helper（BLF-471 follow-up）。
 *
 * Agent 中文名即「名称」（凭据 label）：访问日志 join agent_api_keys 还原
 * key_label；写操作日志按 label 落库快照。日志面板统一展示「中文名 + 英文 ID」。
 * 项目仅用 project_name（查 projects 表还原），不再带编号。
 */

/** Agent 展示：中文名 + 英文 ID（未填名只显示 ID）。 */
export function AgentIdentityCell({
  agentId,
  agentName,
}: {
  agentId: string | null
  agentName: string | null
}) {
  if (!agentId) return <span className="text-muted-foreground">未绑定 / 未鉴权</span>
  return (
    <div className="flex flex-col items-start gap-0.5">
      {agentName ? <span className="font-medium leading-tight">{agentName}</span> : null}
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{agentId}</code>
    </div>
  )
}

/** 项目展示：仅 project_name（BLF-471 follow-up，运营不用编号）。
 * 未命中回退 #id（项目被删但仍记录于审计）。
 */
export function formatProjectRef(projectId: number | null, projectName: string | null): string {
  if (projectName) return projectName
  if (projectId != null) return `#${projectId}`
  return '-'
}
