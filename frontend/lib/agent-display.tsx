'use client'

/**
 * Agent 日志面板共用展示 helper（BLF-471）。
 *
 * 访问日志 / 写操作日志两处面板都展示 Agent（中文名 + 英文 ID）与项目
 * （项目名 + ID），抽到一处避免两份漂移。
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

/** 项目展示：项目名 + (ID)（未命中回退 #ID）。 */
export function formatProjectRef(projectId: number | null, projectName: string | null): string {
  if (projectId == null) return '-'
  return projectName ? `${projectName} (${projectId})` : `#${projectId}`
}
