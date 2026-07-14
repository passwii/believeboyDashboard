import type { Metadata } from 'next'
import MarkdownToWordClient from './markdown-to-word-client'

export const metadata: Metadata = {
  title: 'Markdown 转 Word',
  description: '上传或粘贴 Markdown 内容，实时预览并导出 Word DOCX 文件。',
}

export default function MarkdownToWordPage() {
  return <MarkdownToWordClient />
}
