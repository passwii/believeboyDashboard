import type { Metadata } from 'next'

import BrandRegistrationExamplePage from './brand-registration-example-page'

export const metadata: Metadata = {
  title: '品牌备案示例',
  description: '品牌备案与 UPC 条码豁免申请的包装和产品拍摄示例。',
}

export default function Page() {
  return <BrandRegistrationExamplePage />
}
