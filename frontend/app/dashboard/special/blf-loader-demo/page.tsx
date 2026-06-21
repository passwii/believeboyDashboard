import type { Metadata } from 'next'
import BLFLoaderDemoClient from './blf-loader-demo-client'

export const metadata: Metadata = {
  title: 'BLF Loader Demo',
  description: 'BEL-146 自定义 BLF loading 动画 demo 页面',
}

export default function BLFLoaderDemoPage() {
  return <BLFLoaderDemoClient />
}