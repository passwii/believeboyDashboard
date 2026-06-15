# 前端 fetch 5s 短超时 + 自动重试一次

## 背景

BelieveBoy Dashboard 的前端页面对后端请求缺乏客户端侧超时控制。Next.js 代理 (`frontend/app/api/backend/[...path]/route.ts`) 和服务端 fetch 包装 (`frontend/lib/server/backend-api.ts`) 当前默认都是 10s 超时，而客户端代码（80+ 个文件）通过 `/api/backend/...` 直接调用 `fetch(...)`，**没有传 `AbortController`/`AbortSignal.timeout`**。

体感后果：

- 冷启动一个 dashboard 页面时，如果后端响应慢，骨架屏会一直转 ~10s。
- 刷新页面时，由于 `lib/client-cache.ts` 的 sessionStorage 命中（TTL 2 分钟），数据立即返回 → 用户感觉"刷新立即能加载出来，冷启动卡 15s"。

## 目标

1. 把"客户端 → 代理 → 后端"三层都收紧到 **5s 短超时**。
2. **超时后自动重试 1 次**（仅 1 次，避免对慢后端造成 2× 请求尖刺）。
3. 重试仍失败 → 暴露 `retry()` 给 UI，复用 `components/system/status-retry-button.tsx` 风格，让用户主动重试。
4. 豁免流式 AI Insights 与 long-running 的 scheduled-reports test-email 端点。
5. 治理：禁止 client 组件裸用 `fetch(`，强制走 `fetchWithTimeout` 或 `useApiQuery`。

## 范围

### 改动文件

| 文件 | 改动 |
|---|---|
| `frontend/lib/fetch-with-timeout.ts` | 默认 `timeoutMs` 由 `10_000` → `5_000` |
| `frontend/lib/hooks/use-api-query.ts` | **新建**：`useApiQuery<T>(loader, options)` hook |
| `frontend/lib/server/backend-api.ts` | 默认 `AbortSignal.timeout(10_000)` → `5_000` |
| `frontend/app/api/backend/[...path]/route.ts` | 默认 `timeoutMs = 10_000` → `5_000`（流式/email 端点不变） |
| `frontend/hooks/use-dashboard-overview.ts` 等 7 个手写 useState+useEffect+fetch 的 hook | 改用 `useApiQuery` |
| `frontend/lib/project-client-cache.ts`、`frontend/lib/digital-employee-api.ts`、`frontend/lib/pricing-calculation-api.ts` 等 | `fetch` → `fetchWithTimeout(url, { timeoutMs: 5_000 })` |
| 其余 80+ 个 client 组件 | 顺次改造（先 7 个最常触发的 hook，再扫剩余） |
| `frontend/eslint.config.mjs` | 加自定义规则禁止 client 组件裸用 `fetch(` |

### 不在范围

- 后端响应耗时优化（数据库查询、AI 推理、报表生成）—— 那是另一个 backlog。
- 流式接口（`/ai-insights/{id}/stream`）—— 必须豁免，否则 AI 会卡死。
- `scheduled-reports/test-email` —— AI summary 生成可能 30-80s，保留 60s。
- Server Component / RSC 的 `fetch` —— 只治理 client 组件。

## 设计

### 三层超时架构

```
React 组件
   │
   │ useApiQuery(loader, { timeoutMs: 5000, autoRetry: true })
   │  ├─ 第 1 次请求，5s 超时 → 自动触发第 2 次
   │  └─ 仍失败 → 暴露 retry() 给 UI（StatusRetryButton 风格）
   │
   ▼
fetchWithTimeout(url, { timeoutMs: 5000 })
   │ signal: AbortSignal.timeout(5000)
   │
   ▼
Next.js 代理 /api/backend/[...path]
   │ signal: AbortSignal.timeout(5000)   (流式端点不传，scheduled-reports/test-email 传 60000)
   │
   ▼
backendFetchJson(path, { signal })
   │ signal: AbortSignal.timeout(5000)
   │
   ▼
后端 FastAPI (127.0.0.1:8000)
```

### `useApiQuery` API 规格

```ts
// frontend/lib/hooks/use-api-query.ts
export type ApiQueryErrorKind = 'timeout' | 'network' | 'server' | 'aborted'

export interface ApiQueryError {
  kind: ApiQueryErrorKind
  message: string
  status?: number
  attempts: number
}

export interface UseApiQueryOptions<T> {
  /** 触发刷新的依赖列表。任意一项变化会重发请求。 */
  deps?: ReadonlyArray<unknown>
  /** 单次请求超时。默认 5000。 */
  timeoutMs?: number
  /** 是否在第一次超时时自动重试一次。默认 true。 */
  autoRetry?: boolean
  /** 是否启用（false 时不发请求）。默认 true。 */
  enabled?: boolean
  /** 错误 toast 回调，外部可注入。 */
  onError?: (err: ApiQueryError) => void
}

export interface UseApiQueryResult<T> {
  data: T | undefined
  loading: boolean
  error: ApiQueryError | null
  /** 手动重试（无视 autoRetry，重置 attempts 计数）。 */
  retry: () => void
}

export function useApiQuery<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  options?: UseApiQueryOptions<T>
): UseApiQueryResult<T>
```

**实现要点**：
- 内部用 `AbortController`，超时 = `AbortError`。区分 "user-aborted" 和 "timeout"（看 `signal.reason`）。
- 一次 query 的尝试次数计入 `attempts`，第 1 次失败且 `autoRetry=true` 且 `kind === 'timeout'` → 立即发起第 2 次。
- 第 2 次失败 → 暴露 `error`，停止 loading。
- 卸载时 `controller.abort()`，`kind === 'aborted'` 时不弹错误。
- 错误消息用 `lib/error-utils.ts` 的 `normalizeErrorMessage` 统一。

### 流式端点豁免

- `useApiQuery` 的 `timeoutMs=0` → 跳过超时控制（用 `Infinity` 或干脆不传 signal）。
- Next.js 代理保留原有 pattern 检测：URL 包含 `/ai-insights/.+/stream` 或请求 `Accept: text/event-stream` / `application/x-ndjson` → `timeoutMs = 0`。
- `frontend/lib/server/backend-api.ts` 不需要豁免（业务侧不直接调流式端点）。

### ESLint 规则

在 `frontend/eslint.config.mjs` 中加入自定义规则 `no-bare-fetch-in-client`：

- 触发条件：`.tsx` / `.ts` 文件，文件顶部含 `'use client'` 指令。
- 匹配：源码里有 `fetch(` 调用（排除 import 区域、注释、字符串字面量）。
- 报错信息：`禁止 client 组件裸用 fetch()，请使用 fetchWithTimeout() 或 useApiQuery() 替代。`
- `frontend/app/api/backend/[...path]/route.ts` 等 server-only 文件不受影响。
- 测试文件用 `// eslint-disable-next-line` 标记豁免即可。

## 错误处理

| 场景 | 用户看到 |
|---|---|
| 5s 超时 → 自动重试 1 次成功 | 正常显示数据 |
| 5s 超时 → 自动重试 1 次仍超时 | 立即停止 loading，显示「加载较慢，重试」按钮（用 `StatusRetryButton` 风格） |
| 网络错（`fetch failed` 等） | 自动重试 1 次（不算 timeout 但也走 autoRetry 路径，因为用户体感一样） |
| 服务端 4xx/5xx | 不自动重试，立即显示后端 message + 重试按钮 |
| 组件卸载 | abort，不弹错误 |
| 流式接口 | 不受超时影响，正常 streaming |

## 测试

### 自动化

- `cd frontend && pnpm build`（必有）。

### 业务测试清单（用户手动）

| 测试项 | 期望 | 备注 |
|---|---|---|
| 冷启动 `/dashboard` | KPI 总览 5s 内要么有数据要么出现"重试"按钮 | 不应该停在骨架 10s+ |
| 故意阻塞后端（让 endpoint sleep 8s） | 5s 后看到 loading → 重试按钮切换 | 用 `iptables` 或后端注入 `await asyncio.sleep(8)` |
| 重试按钮点击 | 立即重新发请求 | 与原 `refresh` 行为一致 |
| AI Insights 流式页面（`/dashboard/ai-insights`） | 仍能正常 streaming | 不应被超时砍断 |
| Scheduled Reports Test Email | 60s 内能完成 | 不应被 5s 砍断 |
| 浏览器刷新 → 命中 2 分钟 client cache | 立即有数据 | 不应变化 |
| 服务端主动返回 4xx | 立即停止 loading + 显示后端 message + 重试按钮 | 不自动重试 |

## 风险与回滚

- 风险 1：5s 真的太短 → 文档化 `timeoutMs` 可调；必要时改回 10s（一个常量改 3 处）。
- 风险 2：自动重试对慢后端造成 2× 请求尖刺 → 严格限定为 1 次，且只针对 timeout / network；不重试 4xx/5xx。
- 风险 3：改造面太大漏改 → ESLint 规则 + 后续 review 时重点扫。
- 回滚：把 `5_000` 改回 `10_000` 即可恢复，所有调用方自动跟随（因为是默认值）。

## 实施顺序

1. 改 3 处默认值（`fetch-with-timeout.ts` / `backend-api.ts` / `route.ts`）。
2. 新建 `lib/hooks/use-api-query.ts`。
3. 改 7 个手写 hook（`use-dashboard-overview` 等）使用 `useApiQuery`。
4. 改 `lib/project-client-cache.ts` 等公共 client 库使用 `fetchWithTimeout`。
5. 顺次扫 80+ 调用方，补齐 5s 超时。
6. 加 ESLint 规则。
7. `pnpm build` 通过 → 给用户业务测试清单。
