export type RecognizedFileType =
  | 'sales_report'
  | 'inventory_report'
  | 'ad_report'
  | 'payment_report'
  | 'unknown'

export type RecognitionResult = {
  type: RecognizedFileType
  reason: string
}

function getExtension(fileName: string) {
  const normalized = fileName.trim().toLowerCase()
  const index = normalized.lastIndexOf('.')
  return index >= 0 ? normalized.slice(index) : ''
}

async function readFirstLine(file: File) {
  try {
    const content = await file.slice(0, 4096).text()
    const firstLine = content.replace(/^\uFEFF/, '').split(/\r?\n/)[0] ?? ''
    return firstLine.trim()
  } catch {
    return ''
  }
}

export async function recognizeDataFile(file: File): Promise<RecognitionResult> {
  const lowerName = file.name.toLowerCase()
  const ext = getExtension(file.name)

  if (ext === '.txt') {
    const firstLine = (await readFirstLine(file)).toLowerCase()
    if (firstLine.includes('amazon-order-id')) {
      return { type: 'sales_report', reason: '首行包含 amazon-order-id' }
    }
    if (firstLine.includes('snapshot-date')) {
      return { type: 'inventory_report', reason: '首行包含 snapshot-date' }
    }
    if (lowerName.startsWith('or')) {
      return { type: 'sales_report', reason: '文件名以 or 开头（兼容规则）' }
    }
    if (lowerName.includes('fba')) {
      return { type: 'inventory_report', reason: '文件名包含 fba（兼容规则）' }
    }
    return { type: 'unknown', reason: 'txt 文件未命中销售/库存识别规则' }
  }

  if (ext === '.xlsx') {
    if (lowerName.includes('ad') || lowerName.includes('广告') || lowerName.includes('推广')) {
      return { type: 'ad_report', reason: 'xlsx 文件名命中 ad/广告/推广关键词' }
    }
    return { type: 'unknown', reason: 'xlsx 文件名未命中广告关键词' }
  }

  if (ext === '.csv') {
    const firstLine = (await readFirstLine(file)).toLowerCase()
    if (firstLine.includes('includes amazon marketplace')) {
      return { type: 'payment_report', reason: '首行包含 Includes Amazon Marketplace' }
    }
    return { type: 'unknown', reason: 'csv 文件未命中付款报告识别规则' }
  }

  return { type: 'unknown', reason: `不支持的文件格式: ${ext || '未知'}` }
}
