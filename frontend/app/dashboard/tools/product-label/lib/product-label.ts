/**
 * 产品标签制作：把「文案」+「Made In China」叠加到已上传的单页标签 PDF 上。
 *
 * 处理全部在服务端完成（Python / pypdf + reportlab），前端只负责传文件、
 * 收二进制、触发下载。原件不会被修改，服务端返回的是新文件。
 */

/** 与后端 `product_label_overlay.MAX_TEXT_CHARS` 对齐。 */
export const MAX_TEXT_CHARS = 200
/** 与后端 `product_label_overlay.MAX_TEXT_LINES` 对齐。 */
export const MAX_TEXT_LINES = 3

const API_BASE = '/api/backend'
const ENDPOINT = `${API_BASE}/api/v1/product-label/generate`

export interface GenerateLabelParams {
  file: File
  /** 要追加的文案，可含换行（最多 MAX_TEXT_LINES 行）。 */
  text: string
  /** 是否追加「Made In China」行。 */
  madeInChina: boolean
  /** 供测试注入；默认全局 fetch。 */
  signal?: AbortSignal
}

export interface GeneratedLabel {
  blob: Blob
  filename: string
}

/**
 * 解析 `Content-Disposition`，优先取 RFC 5987 的 `filename*=UTF-8''`。
 * 拿不到就返回 null，由调用方兜底。
 */
export function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null

  const encoded = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''))
    } catch {
      // 非法百分号编码——继续尝试下面的普通 filename
    }
  }

  const plain = header.match(/filename\s*=\s*"?([^";]+)"?/i)
  return plain?.[1]?.trim() || null
}

/** 把后端返回的字节落到本地文件。 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 从响应里抽出可读的错误说明（后端用中文 `detail`）。 */
async function readErrorMessage(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { detail?: unknown } | null
  const detail = payload?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  return `生成失败（${response.status}）`
}

/**
 * 上传标签并取回叠加后的 PDF。
 *
 * @throws Error 消息为面向用户的中文说明，可直接展示。
 */
export async function generateProductLabel({
  file,
  text,
  madeInChina,
  signal,
}: GenerateLabelParams): Promise<GeneratedLabel> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('text', text)
  formData.append('made_in_china', madeInChina ? 'true' : 'false')

  const response = await fetch(ENDPOINT, { method: 'POST', body: formData, signal })

  if (!response.ok) {
    throw new Error(await readErrorMessage(response))
  }

  const blob = await response.blob()
  if (!blob.size) {
    throw new Error('服务端返回了空文件，请重试。')
  }

  const filename =
    parseContentDispositionFilename(response.headers.get('content-disposition')) ??
    fallbackFilename(file.name)

  return { blob, filename }
}

/** 后端不可用时（例如直连代理失败）的兜底文件名。 */
export function fallbackFilename(sourceName: string): string {
  const stem = sourceName.replace(/\.pdf$/i, '').trim() || 'label'
  return `${stem}-labeled.pdf`
}

/** 生成前的前端校验；返回 null 表示通过。 */
export function validateBeforeGenerate(text: string, madeInChina: boolean): string | null {
  if (!text.trim() && !madeInChina) {
    return '请至少填写「文案」或勾选「Made In China」。'
  }
  if (text.length > MAX_TEXT_CHARS) {
    return `文案过长，请控制在 ${MAX_TEXT_CHARS} 字以内。`
  }
  // 后端只取前 MAX_TEXT_LINES 行，这里先拦下来，避免用户以为多写的行生效了。
  const lineCount = text.split('\n').filter((line) => line.trim()).length
  if (lineCount > MAX_TEXT_LINES) {
    return `文案最多 ${MAX_TEXT_LINES} 行，请精简后再生成。`
  }
  return null
}
