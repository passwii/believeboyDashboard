# Markdown / HTML 上传渲染工具（特殊功能分类）

**日期**: 2026-07-08
**状态**: 已批准

---

## 背景与目标

特殊功能分类下需要一个新工具：**用户上传 Markdown（`.md`）或 HTML（`.html`/`.htm`）文件，系统把它渲染成"实际页面"并生成公开链接，任何人凭链接即可查看；同时把文件原样存入 Cloudflare R2，并保留上传历史记录。**

需求要点（已与用户确认）：

1. **入口形态**：在「特殊功能」分组（`sidebar-config.ts` 中 `id: 'special'`）下新增**单一**入口「Markdown/HTML 渲染」，自动识别两种格式，不拆成两个工具。
2. **可见范围**：渲染结果**任何人凭链接可见**——内容存 R2 公开桶（项目已配 `R2_PUBLIC_URL=https://bucket.believeboy.com`），生成公开链接，未登录也能看。
3. **HTML 渲染隔离**：上传的 HTML 是用户内容，直接渲染有 XSS 风险，项目当前**没有任何 HTML 消毒库**。采用 **sandbox iframe** 隔离渲染（沿用 `components/ai-chat-message-content.tsx` 的先例），不引入消毒库。
4. **公开页形态**：自定义公开路由 `/p/{id}`，独立于 Dashboard 登录壳、带站点外壳，未登录可开。
5. **录入方式**：**仅文件上传**（复用 `UploadZone`），不做内联文本编辑器/粘贴。

---

## 数据流

```
用户上传 .md/.html
   │
   ▼
POST /api/v1/page-render/upload  (鉴权)
   │  校验扩展名/类型/体积 → 生成 UUID → 原样存 R2 公开桶 (special-pages/{user_id}/{uuid}.{ext})
   │  写 UploadedPage 记录
   ▼
返回 { id, title, source_format, public_url, created_at }
   │
   ├─► Dashboard 内即时预览 (md → react-markdown；html → <iframe sandbox srcDoc>)
   └─► 历史列表 + 复制公开链接 /p/{id}

任何人打开 /p/{id}
   │
   ▼
app/p/[id]/page.tsx (Server Component, 无登录壳)
   │  调 /api/public/page-render/{id} → 拿 {title, source_format, public_url}
   │  服务端 fetch public_url (R2 公开内容)
   ▼
交客户端 PageRenderer 渲染 (md → react-markdown；html → <iframe sandbox srcDoc>)
```

**核心原则**：R2 作为内容唯一真源；公开页服务端读取 R2 公开 URL，不暴露任何未鉴权的内容接口（仅暴露 id→元数据 的只读接口，且限流）。

---

## 数据模型 `UploadedPage`

新增 `backend/app/models/uploaded_page.py`，SQLAlchemy 2.0 typed 风格，沿用 `inspection_screenshots` 范式。

| 字段 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | `Mapped[str]` | PK，`default=lambda: str(uuid.uuid4())` | **UUID 字符串**作为公开 id，避免被枚举 |
| `owner_user_id` | `Mapped[int]` | 非空，建索引 | 来自 `X-User-Id` 请求头 |
| `title` | `Mapped[str]` | 非空 | 用户提供；缺省取原文件名（去扩展名） |
| `source_format` | `Mapped[str]` | 非空，`'markdown'` / `'html'` | 由扩展名判定 |
| `original_filename` | `Mapped[str]` | 非空 | 用户上传的原始文件名 |
| `content_type` | `Mapped[str]` | 非空 | 文件的 MIME（如 `text/markdown`） |
| `file_size` | `Mapped[int]` | 非空 | 字节数 |
| `r2_key` | `Mapped[str]` | 非空，唯一 | 如 `special-pages/{user_id}/{uuid}.md` |
| `public_url` | `Mapped[str]` | 非空 | `ArtifactService.build_public_url(r2_key)` |
| `created_at` | `Mapped[datetime]` | `server_default=func.now()` | 创建时间 |

**注册**：在 `backend/app/models/__init__.py` 导入并加入 `__all__`（Alembic autogenerate 与 `Base.registry` 发现依赖此注册）。

**迁移**：新增 `backend/alembic/versions/<stamp>_create_uploaded_pages.py`：
- `op.create_table('uploaded_pages', ...)`，列同上（UUID 用 `String(36)` PK）。
- 索引：`ix_uploaded_pages_owner_created` on `(owner_user_id, created_at)`。
- `down_revision` 设为当前 head（实现时查 `alembic/versions` 最新文件）。

---

## 后端接口

新增 `backend/app/api/v1/endpoints/page_render.py`。

### 1. `POST /api/v1/page-render/upload`（需鉴权）

- 输入：`multipart/form-data`，`file: UploadFile = File(...)`，可选 `title: str = Form(None)`。
- 校验（复用 `upload_service.py` 的范式，但用**专用**白名单）：
  - 扩展名 ∈ `{'.md', '.markdown', '.html', '.htm'}`。
  - content-type ∈ `page_render_allowed_content_types`（见配置节）。
  - 体积 ≤ `page_render_max_bytes`（实现时按 1MB 分块读取并累加，超限返回 `413`，沿用 `upload_service.py` 的分块读取方式）。
- 判定格式：`.md`/`.markdown` → `'markdown'`；`.html`/`.htm` → `'html'`。
- 文件名安全化：沿用 `_safe_name` 思路（slugify + uuid 前缀），防止路径/控制字符。
- 存 R2：`upload_bytes_to_r2(settings, key=f'special-pages/{owner_user_id}/{uuid}.{ext}', data=content, content_type=...)`.
- 写记录：`UploadedPage(...)`，提交。
- 返回 `UploadedPageResponse`：`{ id, title, source_format, public_url, created_at }`。

### 2. `GET /api/v1/page-render/history`（需鉴权，读库路由）

- 读库 session：`get_read_db_session`。
- 查询：当前 `owner_user_id` 的记录，按 `created_at desc`，分页 `limit`/`offset`（默认 `limit=20`）。
- 返回：`{ items: UploadedPageResponse[], total: int }`。
- 非管理员也只能看自己的（owner 作用域，天然满足）。

### 3. `DELETE /api/v1/page-render/{id}`（需鉴权，owner 作用域）

- 查记录，校验 `owner_user_id == 当前用户`，否则 `404`。
- `try_delete_file_from_r2(settings, r2_key)`（不抛异常，结构化返回）。
- 删 DB 行，提交。
- 返回 `{ success: true }`。

### 4. `GET /api/v1/page-render/public/{id}`（公开，仅 API Key + 限流）

- **不带 `Depends(protected)`** 依赖——注册到一个单独的 `public_router`（实现时在 `router.py` 或 `main.py` 核实现有路由如何挂载 `protected`，确保此路由不被全局 `protected` 包裹）。
- 仅 API Key 鉴权（FastAPI 层或 slowapi 依赖），无用户上下文。
- **slowapi 限流**（项目已依赖 slowapi）：如 `limiter.limit("30/minute")` 防刷。
- 查询 `UploadedPage` by `id`，不存在 → `404`。
- 返回（**不含内容**，仅元数据）：`{ id, title, source_format, public_url }`。
- 内容由调用方（Next 服务端）自行从 `public_url` 读取。

**Schemas**：`backend/app/schemas/` 下新增 `page_render.py`：`UploadedPageResponse`、`PageRenderHistoryResponse`、`PageRenderPublicResponse`。

---

## 前端 — Dashboard 页（特殊功能内）

### 侧边栏注册

- `frontend/lib/sidebar-config.ts`：`special` 分组的 `items` 追加：
  ```ts
  { title: 'Markdown/HTML 渲染', url: '/dashboard/special/page-render', icon: IconMap.FileCode }
  ```
  （图标从 `IconMap` 现有项中选，避免新增图标依赖。）
- `frontend/lib/dashboard-route-meta.ts`：`DASHBOARD_PAGE_TITLES` 追加 `{ match: '/special/page-render', title: 'Markdown / HTML 渲染' }`。

### 页面

新增 `frontend/app/dashboard/special/page-render/page.tsx` + `loading.tsx`（沿用 `app/dashboard/special/loading.tsx` 的 `DashboardPageLoading`）。

- 使用 `UploadZone`（复用，accept=`.md,.markdown,.html,.htm,text/markdown,text/html`，`maxSize` 与后端 `page_render_max_bytes` 对齐，建议 2）。
- `onUpload(file)`：
  1. **即时预览**（不依赖服务端）：`FileReader.readAsText(file)` 读文本 → md 用 `<ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>`；html 用 `<iframe sandbox="allow-scripts" srcDoc={text} ... />`（沿用 `ai-chat-message-content.tsx` 的 iframe 属性）。
  2. **上传**：`FormData` append `file` → `fetch('/api/backend/api/v1/page-render/upload', { method:'POST', body })`（代理注入 `X-API-Key` + 会话头，沿用 `report-upload/page.tsx` 的 multipart 模式）。
  3. 成功：展示**公开链接 + 复制按钮**，并刷新历史列表。
- **历史列表**：`GET /api/backend/api/v1/page-render/history` → 卡片/表格：标题、格式徽章（Markdown/HTML）、时间、操作「查看公开页」(新标签开 `/p/{id}`)、「复制链接」、「删除」(DELETE 后刷新)。

---

## 前端 — 公开页 `/p/{id}`（登录壳外）

### 代理 Route Handler

新增 `frontend/app/api/public/page-render/[id]/route.ts`：
- **无 `requireUserSession`**（公开）。
- 服务端用 `getBackendApiKeyOrFail()` 拿 API Key，代理 `GET /api/v1/page-render/public/{id}`（用 `backendFetchJson`）。
- 返回 JSON `{ id, title, source_format, public_url }`。
- 失败（404/限流）→ 透传相应状态码。

### 公开页面

新增 `frontend/app/p/[id]/page.tsx`（**放在 `app/dashboard` 之外**，使用独立 layout / 最小外壳，含站点标题与页脚「由 believeboy Dashboard 生成」）。

- **Server Component**：
  1. `fetch('/api/public/page-render/{id}')` 拿元数据 + `public_url`。404 → 渲染 NotFound。
  2. **服务端** `fetch(public_url)` 读取 R2 公开内容（服务端到服务端，无 CORS 问题），拿到原始 `content` 字符串。
  3. 把 `{ content, source_format, title }` 传给客户端组件 `<PageRenderer />`。
- **`<PageRenderer>`（客户端）**：
  - `source_format === 'markdown'` → `<ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>`。
  - `source_format === 'html'` → `<iframe sandbox="allow-scripts" srcDoc={content} className="w-full min-h-screen border-0" title={title} />`。
- 不引入任何用户会话/鉴权；纯公开渲染。

---

## 配置（`backend/app/core/config.py`）

新增：

```python
page_render_allowed_extensions: set[str] = {".md", ".markdown", ".html", ".htm"}
page_render_allowed_content_types: set[str] = {
    "text/markdown", "text/html", "text/plain", "application/octet-stream"
}
page_render_max_bytes: int = 2 * 1024 * 1024  # 2 MB
```

（content-type 放宽容 `text/plain` / `application/octet-stream`，因为浏览器对 `.md`/`.html` 的 MIME 有时候不准。）

---

## 安全

- **HTML 永远 sandbox iframe 隔离**：绝不 `dangerouslySetInnerHTML` 渲染用户 HTML。Markdown 走 `react-markdown`（默认不执行原始 HTML，天然安全）。
- **公开 id 用 UUID**：不可被顺序枚举。
- **公开读接口限流**：slowapi 限流防刷；仅返回元数据，不返回内容。
- **删除双清**：`try_delete_file_from_r2` + 删 DB 行，owner 作用域。
- **R2 桶本就公开**（符合"任何人凭链接"需求）；对象 key 前缀 `special-pages/` 隔离。
- **体积上限** `page_render_max_bytes` 防滥用。

---

## 已知限制（v1）

- Markdown 内的**相对图片 URL**、HTML 内的**相对资源**（CSS/JS/图片）在 sandbox iframe / `srcDoc` 下可能无法解析（文档 base 缺失）。多数用例用绝对 URL 或无资源即可。后续优化可选：注入 `<base href>` 指向 R2 对象目录，或后端用 `mistune` 预渲染。
- 不做版本管理：每次上传 = 一条新记录；不做软删，删除即硬删。

---

## 测试

### 后端（pytest）

- 上传 `.md` → `200` + 返回 `public_url` + DB 存在记录（`source_format='markdown'`）。
- 上传 `.html` → `200` + 记录 `source_format='html'`。
- 上传非法扩展名（如 `.exe`）→ `400`。
- 上传超过 `page_render_max_bytes` → `413`。
- `history` 仅返回当前用户记录（用两个不同用户会话验证隔离）。
- `DELETE {id}` → R2 对象删除 + DB 行删除（用 `try_delete_file_from_r2` 的 mock 或测试桶验证）。
- `public/{id}` → 无需用户鉴权可返回元数据；不存在 → `404`；超限额流（可选）。

### 前端

- `UploadZone` 接线正确（accept / maxSize）。
- Markdown 预览用 `react-markdown` 渲染；HTML 预览用 sandbox iframe。
- 历史列表展示、复制链接、删除刷新。
- `/p/{id}` 公开页在**未登录**状态下正确渲染 md 与 html。

### 迁移

- `alembic upgrade head` 通过，`uploaded_pages` 表与索引建立成功。

---

## 实现文件清单

**后端**
- `backend/app/models/uploaded_page.py`（新增）
- `backend/app/models/__init__.py`（注册）
- `backend/alembic/versions/<stamp>_create_uploaded_pages.py`（新增）
- `backend/app/schemas/page_render.py`（新增）
- `backend/app/api/v1/endpoints/page_render.py`（新增）
- `backend/app/api/v1/router.py` 或 `main.py`（注册 public_router）
- `backend/app/core/config.py`（新增 3 个配置项）

**前端**
- `frontend/lib/sidebar-config.ts`（加菜单项）
- `frontend/lib/dashboard-route-meta.ts`（加标题）
- `frontend/app/dashboard/special/page-render/page.tsx`（新增）
- `frontend/app/dashboard/special/page-render/loading.tsx`（新增）
- `frontend/app/api/public/page-render/[id]/route.ts`（新增）
- `frontend/app/p/[id]/page.tsx`（新增）
- `frontend/app/p/[id]/page-renderer.tsx`（新增，客户端组件）
