import type { Metadata } from 'next'

import ProductLabelClient from './product-label-client'

export const metadata: Metadata = {
  title: '产品标签制作',
  description: '上传单个产品标签 PDF，追加自定义文案与 Made In China 标注后下载。',
}

export default function ProductLabelPage() {
  return <ProductLabelClient />
}
