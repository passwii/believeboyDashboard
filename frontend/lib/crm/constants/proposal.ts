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
 */

/** 单个方案 HTML 的上传上限（MB）。 */
export const PROPOSAL_MAX_UPLOAD_MB = 20

/** 单个方案 HTML 的上传上限（字节）—— 与后端 `crm_proposal_max_bytes` 同口径。 */
export const PROPOSAL_MAX_UPLOAD_BYTES = PROPOSAL_MAX_UPLOAD_MB * 1024 * 1024
