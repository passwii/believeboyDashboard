/**
 * 方案上传失败的错误文案分档（BLF-1404）。
 *
 * 背景：上传失败的几类根因原本都落到同一句「创建失败 / 上传失败」，用户无法
 * 判断该重试、该压缩文件、还是该换文件：
 *   ① 413 —— **两种来源，口径完全不同**（见下）→ **压缩或换文件**
 *   ② 504 —— 代理 deadline 或后端超时 → **稍后重试**
 *   ③ 其它 4xx/5xx —— 保留后端 detail 原文（如「不支持的文件类型」）
 *
 * ⚠️ **413 必须分两档**（BLF-1404 复核，Codex P1）：
 *   - **平台网关 413**：Vercel 函数网关 4.5MB 请求体硬上限，超限返回
 *     `413 FUNCTION_PAYLOAD_TOO_LARGE`（响应体是**纯文本**，不是 JSON）。
 *     实际阈值 2026-10-20 生产实测：4,400,000 B → 401；4,500,000 B → 413。
 *     → 用户传 5MB 也会中招，但提示若说「超过 20MB」就是**误导**（且会把用户
 *       引向「再压缩」这个无效动作 —— 压到 10MB 依然失败）。
 *   - **后端业务 413**：后端 `crm_proposal_max_bytes`（20MB）超限，
 *     响应体是 **JSON**（`{"detail": "文件超过 20971520 字节上限"}`）。
 *     → 这条才用 20MB 口径。
 *
 * 区分方式：看错误体是不是 JSON。网关 413 的体是纯文本（`res.json()` 抛错 →
 * `body` 为 undefined），后端 413 的体是 JSON 且带 `detail`。
 *
 * 错误形状（见 `lib/crm/api/http-crm-client.ts`）：后端 / 代理返回的错误体经
 * `parseApiError` 解析成 `ApiError`，它带 `status` + `body`；`message` 优先取
 * body 里的 `detail`（后端 FastAPI 口径），其次 `message`（代理口径）。
 */

import { ApiError } from '@/lib/crm/api/http-crm-client'
import {
  PROPOSAL_MAX_UPLOAD_MB,
  PROPOSAL_UPLOAD_GATEWAY_LIMIT_MB,
} from '@/lib/crm/constants/proposal'

/** 上传失败时给用户看的标题 + 文案。 */
export interface ProposalUploadErrorCopy {
  readonly title: string
  readonly message: string
}

/**
 * 判断 413 是**平台网关**拒的（Vercel 4.5MB 硬上限）还是**后端业务**拒的（20MB）。
 *
 * 判据：响应体是不是**后端的 JSON 错误体**（带字符串 `detail`）。
 * - 网关 413：请求体在**到达函数之前**就被 Vercel 网关拒掉，浏览器直接收到
 *   平台原始响应 —— `content-type: text/plain`，体是
 *   `Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE`。
 *   → `res.json()` 抛错 → `ApiError.body` 为 `undefined`（或非对象）。
 * - 后端 413：FastAPI 统一返回 `{"detail": "文件超过 20971520 字节上限"}`
 *   → `ApiError.body` 是带字符串 `detail` 的对象。
 *
 * ⚠️ 不能只看 `message` 里有没有「上限」两个字 —— 网关的兜底文案
 * 「CRM 请求失败（413）」同样不含，但**错误体形状**才是可靠信号。
 * ⚠️ 也不靠 `x-vercel-error` 响应头 —— 网关拒请求时**根本进不到我们的函数**，
 * 头不会经过代理的 header 白名单。
 */
function isGatewayPayloadTooLarge(error: ApiError): boolean {
  if (error.status !== 413) return false
  const body = error.body
  if (body === null || typeof body !== 'object') return true
  const detail = (body as { detail?: unknown }).detail
  return typeof detail !== 'string'
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
      // 平台网关 4.5MB 硬上限：说 20MB 是误导 —— 用户压到 10MB 依然失败。
      if (isGatewayPayloadTooLarge(error)) {
        return {
          title: '文件过大',
          message:
            `上传体积超出平台限制（约 ${PROPOSAL_UPLOAD_GATEWAY_LIMIT_MB}MB），` +
            '请压缩图片后重传。',
        }
      }
      // 后端业务上限（20MB）：这才是后端配置的真实口径。
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
