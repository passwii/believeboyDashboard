import { Suspense } from 'react'

import StoreInfoPage from './page-client'

export default function ProjectInfoPage() {
  return (
    <Suspense fallback={<div className="p-6">正在加载项目信息...</div>}>
      <StoreInfoPage />
    </Suspense>
  )
}
