/**
 * 客户方案（Proposal）域常量。
 *
 * 上传链路（2026-10-21 分段方案）：
 * - ≤ `PROPOSAL_CHUNK_THRESHOLD_BYTES`：沿用一次性 multipart（行为不变）；
 * - > 阈值：前端按后端返回的 `chunk_size` 分段 → 后端合并 → 现有 R2 上传。
 *
 * 这样既绕开 Vercel 函数约 4.5MB 的请求体硬上限，又**不改 R2 桶/CORS**。
 *
 * ⚠️ 20MB 是后端业务上限（`crm_proposal_max_bytes`）。分段单段 3MB，
 * 由后端下发的 `chunk_size` 决定；本文件的阈值只决定走哪条前端分支。
 */

/** 单个方案 HTML 的上传上限（MB）—— **后端业务上限**，与后端 `crm_proposal_max_bytes` 同口径。 */
export const PROPOSAL_MAX_UPLOAD_MB = 20

/** 单个方案 HTML 的上传上限（字节）—— 与后端 `crm_proposal_max_bytes` 同口径。 */
export const PROPOSAL_MAX_UPLOAD_BYTES = PROPOSAL_MAX_UPLOAD_MB * 1024 * 1024

/**
 * 走一次性 multipart 的最大字节数。
 *
 * 4MB 是留给 Vercel 4.5MB 请求体上限的安全余量；超过即走分段。
 * 与后端 `proposal_chunked_upload.CHUNK_SIZE`（3MB）独立：阈值决定分支，
 * 单段大小由后端 init 响应下发。
 */
export const PROPOSAL_CHUNK_THRESHOLD_BYTES = 4 * 1024 * 1024

/**
 * 旧的“一次性 multipart 经 Vercel 代理”有效上限（仅用于错误文案/回退说明）。
 * 分段上传启用后，方案不再受该限制；保留常量避免错误文案分档失效。
 */
export const PROPOSAL_UPLOAD_GATEWAY_LIMIT_MB = 4

/**
 * 当前 CRM 客户端走的是**真实后端**还是 **mock**。
 *
 * 运行时默认 `http`；生产构建显式 `mock` 会被 `crm-client-provider.tsx` 拒绝。
 * Mock 仅用于显式测试配置（Playwright 自包含 fixture / 单测）。
 */
export const CRM_API_MODE = process.env.NEXT_PUBLIC_CRM_API_MODE ?? 'http'

/** 是否走真实后端（`http`）—— 与 `crm-client-provider.tsx` 的判定同源。 */
export const CRM_USES_REAL_BACKEND = CRM_API_MODE === 'http'

/**
 * 本地预校验实际生效的上限（MB）。
 *
 * 分段上传不再受 Vercel 4.5MB 网关限制，因此始终等于后端业务上限 20MB。
 */
export const PROPOSAL_EFFECTIVE_UPLOAD_LIMIT_MB = PROPOSAL_MAX_UPLOAD_MB
