/**
 * 方案上传失败的错误文案分档（BLF-1404）。
 *
 * 背景：上传失败的三类根因原本都落到同一句「创建失败 / 上传失败」，用户无法
 * 判断该重试、该压缩文件、还是该换文件：
 *   ① 413 —— 文件超过后端 `crm_proposal_max_bytes`（20MB）→ **压缩或换文件**
 *   ② 504 —— 代理 deadline 或后端超时 → **稍后重试**
 *   ③ 其它 4xx/5xx —— 保留后端 detail 原文（如「不支持的文件类型」）
 *
 * 错误形状（见 `lib/crm/api/http-crm-client.ts`）：后端 / 代理返回的错误体经
 * `parseApiError` 解析成 `ApiError`，它带 `status` + `body`；`message` 优先取
 * body 里的 `detail`（后端 FastAPI 口径），其次 `message`（代理口径）。
 */

import { ApiError } from '@/lib/crm/api/http-crm-client'
import { PROPOSAL_MAX_UPLOAD_MB } from '@/lib/crm/constants/proposal'

/** 上传失败时给用户看的标题 + 文案。 */
export interface ProposalUploadErrorCopy {
  readonly title: string
  readonly message: string
}

/**
 * 把上传异常翻译成可区分的提示。
 *
 * @param error    catch 到的异常（`ApiError` / 网络 `Error` / 其它）
 * @param fallback 兜底文案（对应「建方案」还是「上传新版本」）
 */
export function proposalUploadErrorCopy(
  error: unknown,
  fallback: { title: string; message: string }
): ProposalUploadErrorCopy {
  if (error instanceof ApiError) {
    if (error.status === 413) {
      return {
        title: '文件过大',
        message: `文件超过 ${PROPOSAL_MAX_UPLOAD_MB}MB 上限，请压缩图片或拆分后重传。`,
      }
    }
    if (error.status === 504) {
      return {
        title: '上传超时',
        message: '上传超时，请稍后重试；若反复超时，请压缩文件后重传。',
      }
    }
    // 其它错误：保留后端 detail / 代理 message 原文，别覆盖掉可操作信息。
    return { title: fallback.title, message: error.message || fallback.message }
  }

  // 网络层错误（`requestForm` 抛的是无 status 的 Error）与未知异常。
  return {
    title: fallback.title,
    message: error instanceof Error && error.message ? error.message : fallback.message,
  }
}
