import type { Metadata } from 'next'

import ProjectLaunchClient from './project-launch-client'

export const metadata: Metadata = {
  title: '项目启动台',
  description: '按项目追踪店铺启动与产品开发流程进度，并下载对外资料文档',
}

export default function ProjectLaunchPage() {
  return <ProjectLaunchClient />
}
