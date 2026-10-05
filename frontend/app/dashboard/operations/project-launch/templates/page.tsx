import type { Metadata } from 'next'

import WorkflowTemplateEditor from './workflow-template-editor'

export const metadata: Metadata = {
  title: '流程模板管理',
  description: '管理项目启动台的流程模板与节点内容',
}

export default function ProjectLaunchTemplatesPage() {
  return <WorkflowTemplateEditor />
}
