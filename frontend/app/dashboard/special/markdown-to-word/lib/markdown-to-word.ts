import { createMarkdownDocxBlob } from './markdown-docx'

export function formatMarkdownFileSize(bytes: number): string {
  if (bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function createWordFilename(sourceName?: string): string {
  const baseName = sourceName
    ? sourceName.replace(/\.md$/i, '').replace(/\.[^.]+$/, '').trim()
    : 'markdown-document'

  const safeBaseName = baseName
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 80)

  const timestamp = new Date().toISOString().slice(0, 19).replace(/-/g, '').replace(/T/g, '').replace(/:/g, '')
  return `${safeBaseName || 'markdown-document'}-${timestamp}.docx`
}

export async function downloadMarkdownAsWord(markdown: string, filename: string): Promise<void> {
  const blob = await createMarkdownDocxBlob(markdown)
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()

  window.URL.revokeObjectURL(url)
}

export async function readMarkdownFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(new Error('文件读取失败，请重试'))
    reader.readAsText(file, 'utf-8')
  })
}

export async function downloadMarkdownAsPdf(markdown: string, filename: string): Promise<void> {
  const { markdownToPdf } = await import('./markdown-pdf')
  const blob = await markdownToPdf(markdown)
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()

  window.URL.revokeObjectURL(url)
}

export function createPdfFilename(sourceName?: string): string {
  return createWordFilename(sourceName).replace(/\.docx$/i, '.pdf')
}
