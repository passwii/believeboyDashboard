# 客户方案页面设计（CRM · 单 HTML + 版本管理）

> 日期：2026-10-17 ｜ 分支：`feat/crm-customer-proposals` ｜ 迁移：`283`
> 状态：已实施
> 关联：`docs/superpowers/plans/2026-07-26-crm-main-roadmap.md`（CRM 主线）

## 1. 需求

在 CRM 分类下新增「客户方案」页面：

1. **上传与解析**：用户上传**单个 HTML** 文件；系统解析并适配本项目前端后**固化保存**。
2. **回看与下载**：回看可预览；下载仍是**单个 HTML** 文件。
3. **版本管理**：同一方案支持多版本。

用户原始疑问：「把文件放在 Cloudflare R2 里面进行解析和查看，是不是比较合适？」

## 2. 关键结论

### 2.1 R2 只负责「存」和「发」，不负责「解析」「查看」

R2 是 S3 兼容对象存储（只认字节），没有计算能力、不理解 HTML、也没有业务版本语义。
职责必须拆开：

| 环节 | 归属 | 理由 |
| --- | --- | --- |
| 解析 / 适配 | 后端 FastAPI（Python） | 要读字节 + 改写 DOM，R2 做不到 |
| 固化保存 | R2（raw + adapted 两个对象） | 不可变字节仓库，天然适合「冻结版本」 |
| 版本管理 | PostgreSQL | 版本要带 谁/何时/为什么/当前指向，对象存储给不了 |
| 查看 | Next.js（sandbox iframe） | 复用现有渲染范式 |
| 下载 | 后端流式返回 | 要带权限校验 + `Content-Disposition` |

> R2 = 字节仓库 · PG = 版本台账 · 后端 = 解析车间 · 前端 = 展示窗口。

### 2.2 「适配前端」= 主题令牌注入 + 单文件冻结，**不**做组件化

**不**把 HTML 编译成 React/TSX：① 需求 2 要求下载仍是单个 HTML，组件化会丢真源；
② HTML→组件有损且脆弱；③ 维护成本远大于收益。

**做**（上传时一次性完成，结果冻结）：
1. 校验 `.html/.htm`、大小上限、非空；
2. 探测**相对引用**（`./x.css`、`assets/a.js`）→ 提示但不断言阻断（单文件存储下必然 404）；
3. 规范化骨架：补 `<!DOCTYPE>` / `<head>` / `<meta charset>` / `<meta viewport>`；
4. 在 `<head>` **开头**注入本项目设计令牌（色板 / 圆角 / 字体 + 暗色）与 `body` 基线
   —— 文档自身的 `<style>` 会覆盖它，**尊重原设计，只兜底不缺省**；
5. raw + adapted **两份都写 R2**，PG 记 `adapted_sha256`。

**不**内联外链资源（要发网络请求 + SSRF 风险，收益低）；**不** sanitize 掉 `<script>`
（会破坏文档功能）——安全性由渲染侧 **`sandbox="allow-scripts"`** 承担。

### 2.3 版本管理用 DB 版本链，**不**用 R2 Object Versioning

R2 自带对象版本只是「防误删」运维兜底：没有变更备注、没有「当前版本」概念、不能按版本授权。
做法：R2 key 按版本隔离（`crm-proposals/{id}/v{N}/{raw,adapted}.html`）；
PG 版本行 **append-only、永不 UPDATE**；`crm_proposals.current_version_no` 指向当前版本。

## 3. 层级（用户问的「采用什么样的层级」）

**客户 → 方案 → 版本**（三层）；文件不是一层，而是版本的载荷。

```text
crm_customers（已有）
  └─ crm_proposals            对某客户的方案（可多份）
       └─ crm_proposal_versions   每次上传一个不可变版本
```

- **不做 4 层**（再挂「文件表」）：输入约束是「单个 HTML」，一个版本恒等于一个文件，多一层只是多张空表。
- **不做 2 层**（不绑客户）：CRM 全围绕客户，不绑就退化成「又一个工具箱页面」，与
  「工具箱 → Markdown/HTML 渲染」重复。
- **线索侧先不绑**（YAGNI）。
- **不新建分类表**：用 `proposal_type` 枚举（`onboarding/operation/quotation/other`）。

## 4. 数据模型（迁移 283）

```text
crm_proposals
  id (Integer PK) · title(200) · proposal_type(32, default other)
  status(20: draft/published/archived) · customer_id(FK crm_customers, ondelete SET NULL, null)
  owner_id(36) · current_version_no(int, default 0) · created_by(36)
  created_at · updated_at
  index: idx_cp_customer / idx_cp_owner_status / idx_cp_updated

crm_proposal_versions
  id (Integer PK) · proposal_id(FK crm_proposals, ondelete CASCADE)
  version_no(int) · raw_r2_key(512, unique) · adapted_r2_key(512, unique)
  adapted_sha256(64) · original_filename(255) · content_type(64) · file_size(int)
  change_note(500) · created_by(36) · created_at
  unique(proposal_id, version_no) · index idx_cpv_proposal
```

`customer_id` 可空（允许「未关联方案」/模板）；客户是软删，`SET NULL` 仅作硬删兜底。

## 5. 接口

```http
POST   /api/v1/crm/proposals                              新建 + 首版（multipart）
POST   /api/v1/crm/proposals/{id}/versions                追加新版本（multipart）
GET    /api/v1/crm/proposals                              列表（scope/keyword/filters/sort/page）
GET    /api/v1/crm/proposals/{id}                         详情（含版本链）
PATCH  /api/v1/crm/proposals/{id}                          改 标题/类型/状态/客户
DELETE /api/v1/crm/proposals/{id}                          删方案（级联版本 + 尽力删 R2）
GET    /api/v1/crm/proposals/{id}/versions/{n}/content     预览（返回 HTML 文本）
GET    /api/v1/crm/proposals/{id}/versions/{n}/download    下载（?raw=1 取原始上传版）
```

- 写操作走 `services/crm/audit_service.record_log`（entity_type=`proposal`），与业务写入同事务 commit。
- 权限沿用 `services/crm/permissions.py`（`resolve_scope` / `require_owner_or_admin`）。
- 列表筛选只支持 `{field, op:'eq', value}`（状态/类型/客户），字段白名单 → 未知字段 400。
- 非管理员不得把方案挂到别人的客户（403）；客户不存在/已软删 → 404。

## 6. 安全（与工具箱 page-render 的**有意偏离**）

工具箱的 `page-render` 用**公开桶 + 不可枚举 UUID**——适用于「谁都能看的特殊页面」。
客户方案含**报价 / 客户名 / 运营策略**，因此：

- 桶保持私有；预览走后端鉴权后返回文本；下载走后端流式转发（每次请求都过鉴权）；
- **不**返回公开 URL、**不**签发免鉴权的 presigned URL；
- 渲染仍用 `sandbox="allow-scripts"` 的 iframe（srcDoc），作为脚本隔离的主防线。

## 7. 前端

```text
app/dashboard/crm/proposals/page.tsx            列表（搜索/状态/类型/范围 + 新建 Dialog）
app/dashboard/crm/proposals/[id]/page.tsx       详情（预览 + 版本链 + 上传新版本 + 编辑）
components/crm/proposal/preview.tsx             applyPreviewTheme（纯函数）+ sandbox iframe
components/crm/proposal/version-timeline.tsx    版本链（切换预览 / 下载适配版 / 下载原始版）
components/crm/proposal/upload-form.tsx         新建表单 + 追加版本表单
components/crm/proposal/pill.tsx                状态/类型终端 pill
lib/crm/types/proposal.ts                       类型 + 下载文件名/大小格式化（纯函数）
lib/crm/api/{crm-client,http-crm-client,mock-crm-client,dto-mappers}.ts
lib/sidebar-config.ts / lib/dashboard-route-meta.ts   导航「客户方案」
```

**主题同步**：iframe 是独立文档，读不到父页面 `.dark` class。冻结产物自带 light/dark 双令牌
（`prefers-color-scheme` + `data-bb-theme`）；查看侧用 `applyPreviewTheme` 把 app 当前主题
强制写进 `<html>`。**只影响预览**，下载产物保持双模式不变。

**下载文件名**：`<标题>-v<N>.html`（适配版）/ `<标题>-v<N>-原始.html`（原始版），
与后端 `build_download_filename` 同口径。

## 8. 决策记录（用户拍板 2026-10-17）

| 决策点 | 结论 |
| --- | --- |
| 绑定客户 | 允许为空（`customer_id` nullable），UI 默认可选 |
| 下载哪份 | 默认**适配版**（带主题、仍单文件）；次选项**原始上传版**（交付保真/审计） |
| 可见范围 | 按 CRM scope（owner/admin），与客户列表一致（`mine`/`all`） |
| 适配强度 | 只做「骨架 + 主题令牌注入」，零新依赖；DOM 级改写等有真实样本再上 |

## 9. 验证

- 后端：`tests/services/crm/test_proposal_render.py`（16）+ `tests/api/crm/test_proposals_api.py`（30）
- 前端：`components/crm/proposal/*.test.*` + `lib/crm/types/proposal.test.ts`（21）
- 迁移图：`backend/scripts/check_alembic.py`（单 head / 命名 / 无重复）
- 契约：`make openapi-export` → `openapi-check` OK；`pnpm gen:api-types:check` OK

## 10. 刻意不做（后续再评估）

- HTML→React 组件编译；外链资源内联；把 `uploaded_pages` 与方案表合并（语义不同，会互相污染）；
- 方案审批流 / 客户外链分享 / R2 object versioning 作为产品版本；按 `proposal_type` 建分类表。
