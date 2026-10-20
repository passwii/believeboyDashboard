/**
 * 客户方案（Proposal）域常量。
 *
 * 目前只有「单个 HTML 上传上限」一条 —— 它同时被三处消费，**必须同源**：
 *   ① 上传表单的本地预校验（`components/crm/proposal/upload-form.tsx`）
 *   ② 上传失败提示文案（`lib/crm/method/proposal-upload-error.ts`）
 *   ③ 后端 `crm_proposal_max_bytes`（backend/app/core/config.py）—— 跨仓，靠注释对齐
 *
 * 口径：20MB（#753 / BLF-1404 把原先的 5MB 放宽）。
 * ⚠️ 改这里前先确认后端 `settings.crm_proposal_max_bytes` 同值，否则前端放行
 * 后端仍会 413（或反过来前端误拦合法文件）。
 *
 * ⚠️⚠️ **20MB 是「后端业务上限」，不是「生产链路可用上限」**（BLF-1404 复核）：
 * 生产前端部署在 Vercel，函数网关对**请求体**有 4.5MB 硬上限
 * （Vercel Functions Limits → Request body size；超限返回
 * `413 FUNCTION_PAYLOAD_TOO_LARGE`，**发生在鉴权之前**，应用代码一行都没跑）。
 * 2026-10-20 生产实测：4,400,000 B → 401（进到路由）；4,500,000 B → 413。
 * → 走 Next 代理上传时，**实际能传的只有约 4.4MB**；20MB 只能直连后端或
 * 走 presigned 直传 R2（见 BLF-1412）。
 * 所以本文件的「预校验上限」与「提示文案上限」必须分开：
 *   - `PROPOSAL_MAX_UPLOAD_MB` = 后端业务上限（20MB）→ 用于**说明性**文案
 *   - `PROPOSAL_UPLOAD_GATEWAY_LIMIT_MB` = 代理链路有效上限（约 4MB）→ 用于**拦截**
 * 详见 `lib/crm/method/proposal-upload-error.ts` 的 413 分档。
 */

/** 单个方案 HTML 的上传上限（MB）—— **后端业务上限**，与后端 `crm_proposal_max_bytes` 同口径。 */
export const PROPOSAL_MAX_UPLOAD_MB = 20

/** 单个方案 HTML 的上传上限（字节）—— 与后端 `crm_proposal_max_bytes` 同口径。 */
export const PROPOSAL_MAX_UPLOAD_BYTES = PROPOSAL_MAX_UPLOAD_MB * 1024 * 1024

/**
 * **经 Next 代理上传时的有效上限**（MB）—— Vercel 函数网关 4.5MB 请求体硬上限。
 *
 * 取 4 而不是 4.4：multipart 封装要吃掉一部分（boundary + 文件头），
 * 且各文件体积差异大 —— 留够安全余量，别让用户在 4.3MB 上撞墙。
 *
 * ⚠️ 这不是「产品上限」，是**平台限制**。真正的解法是绕开函数代理
 * （presigned 直传 R2 / 直连后端），见 BLF-1412。
 */
export const PROPOSAL_UPLOAD_GATEWAY_LIMIT_MB = 4

/**
 * 当前 CRM 客户端走的是**真实后端**还是 **mock**。
 *
 * 决定「本地预校验用哪个上限」：
 * - `http`（生产）→ 上传经 Next 代理 → 受 Vercel 4.5MB 网关限制 →
 *   预校验上限 = `PROPOSAL_UPLOAD_GATEWAY_LIMIT_MB`（4MB）。
 * - `mock`（本地开发 / 测试）→ 文件只进 localStorage，**不过任何网关** →
 *   预校验上限 = `PROPOSAL_MAX_UPLOAD_MB`（20MB，后端业务口径）。
 *
 * 口径与 `lib/crm/api/crm-client-provider.tsx` 的 `apiMode` 同源。
 */
export const CRM_API_MODE = process.env.NEXT_PUBLIC_CRM_API_MODE ?? 'mock'

/** 是否走真实后端（`http`）—— 与 `crm-client-provider.tsx` 的判定同源。 */
export const CRM_USES_REAL_BACKEND = CRM_API_MODE === 'http'

/**
 * **本地预校验实际生效的上限**（MB）。
 *
 * ⚠️ 这不是「产品上限」：真实上限取决于部署形态。
 * - 走 Next 代理（生产）→ Vercel 网关 ~4.4MB 硬卡（平台限制，不可调）。
 * - 直连后端 / presigned 直传（BLF-1412 落地后）→ 后端业务上限 20MB。
 */
export const PROPOSAL_EFFECTIVE_UPLOAD_LIMIT_MB = CRM_USES_REAL_BACKEND
  ? PROPOSAL_UPLOAD_GATEWAY_LIMIT_MB
  : PROPOSAL_MAX_UPLOAD_MB
