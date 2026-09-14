# AI 洞察三页快照（BLF-1062）

「AI 洞察 / AI 广告分析 / AI 库存健康」三页 6 条 `GET` 端点的**真实后端响应**，用于把
「同源同结构」（issue §口径 1）变成可执行断言（`InsightDecodingTests` / `InsightClientTests` /
`InsightStoreTests` / `InsightRenderingTests`）。

## 为什么是「同源同结构」而不是「同源同值」

AI 产出文本**不可复现** —— 逐字比对两次生成结果没有意义。可比对物是三样：

1. **run detail 的字段与状态机**（`queued / aggregating / generating / finalizing /
   completed / failed / cancelled`，以及 `InsightStage` 是 `InsightStatus` 的子集）；
2. **SSE 的事件类型序列**（`snapshot → done` / `snapshot → error`，以及 `id:` 游标的顺序）；
3. **summary 与数值型字段**（`total` / `progress_percent` / `usage.total_tokens` / `seq`）。

**不断言模型文本内容** —— 只断言渲染路径（Markdown → 块序列 → 视图）。

## 两段来源（这是本批与 S5.1 / S5.2 最大的差异）

| 段 | 端点 | 库 | 文件 |
| --- | --- | --- | --- |
| A | `GET /ai-insights`、`/ai-insights/{id}`、`/ai-insights/schedules`、`/ai-insights/{id}/stream` | 生产快照库 `BLF` | `ai-insights-*.json` / `ai-insights-stream-terminal.txt` |
| B | `GET /insight/runs/{run_id}`、`/insight/runs/{run_id}/stream` | 隔离库 `BLF_test` | `insight-run-*.json` / `insight-run-stream-*.txt` |

**为什么 B 段不在生产快照库上抓**：canonical run 的表在生产快照里是**空的**
（实测 `select count(*) from insight_runs` = 0，2026-09-14）。而本批**只做只读**（§口径 4），
不可能通过 `POST /insight/runs` 造一条真 run。因此 B 段在隔离库 `BLF_test` 上插两条**真实终态
run 行**（固定 `run_id`：completed 一条、failed 一条），抓完即删 —— **不写 `BLF`**
（AGENTS.md 的硬约束），也不发任何写端点。

响应本身 100% 由后端真实代码产出：`to_detail` 序列化 + `insight_runs.py` 的 `_sse_frame`
帧编码 + 它自己的 `Last-Event-ID` 校验。B 段的 Redis 流是空的，正好走
`services/insight/subscriber.py` 里那条「run 已终态 + 流已过期 → 从 DB 快照合成终态帧」的
分支，把「断线后重连续传仍能拿到终态」这条语义钉成真实帧（`insight-run-stream-*-resume.txt`
就是带 `Last-Event-ID` 的第二次响应：只回终态帧、不回已见帧）。

## 抓取口径（`manifest.json` 里逐项记着）

- 鉴权：`X-API-Key`（主 key，取 `backend/.env` 的 `API_KEY`）+ `X-Is-Admin: true`
  - `X-Operator: admin`（与 S5.1 / S5.2 同一组账号上下文）。
- 固定参数：`project_id=1`、`country=US`、`limit=20`（**与 S5.1 / S5.2 同一组**，便于三批互相对照）。
  B 段例外：隔离库里没有 `id=1` 的项目（`ensure_project_access` 会 404「项目不存在」），
  故用该库里真实存在的 `427`（「测试项目」）。
- 抓取时点：见 `manifest.json` 的 `captured_at`；逐文件 `sha256` / `bytes` 同在 manifest，
  `InsightDecodingTests.testCommittedSnapshotHashesMatchManifest` 会拦下不一致。
- 脚本：`macos/scripts/capture-insight-fixtures.py`（**只读 GET，无写请求**）。

## 逐文件说明

| 文件 | 内容 |
| --- | --- |
| `ai-insights-list.json` | 洞察列表（`project_id=1&country=US&limit=20&offset=0`），生产快照 47 条 |
| `ai-insights-ad-analysis-list.json` | 同一端点 + `insight_type=ad_analysis`（广告分析页的历史列表口径） |
| `ai-insights-detail.json` | 列表首条（id=46）的明细：`content`（Markdown 正文）+ `strategy_metadata`（该条为 `null`） |
| `ai-insights-schedules.json` | 定时列表（生产快照当前 **0 条** —— 空态夹具） |
| `ai-insights-stream-terminal.txt` | 旧链路 SSE 原文：已终态 → 立即一帧 `status` 后关闭。**不发 `id:`** |
| `insight-run-detail-completed.json` | 终态 completed 的 run detail（`outputs.main` / `usage` / `resume`） |
| `insight-run-stream-completed.txt` | 该 run 的真实帧序列：`snapshot → done`，每帧带 `id:` 游标 |
| `insight-run-stream-completed-resume.txt` | 带 `Last-Event-ID` 的续传响应：只回 `done` |
| `insight-run-detail-failed.json` | 终态 failed 的 run detail（typed `error.UPSTREAM_TIMEOUT`） |
| `insight-run-stream-failed.txt` | `snapshot → error` |
| `insight-run-stream-failed-resume.txt` | 带 `Last-Event-ID` 的续传响应：只回 `error` |
| `insight-run-stream-invalid-cursor.json` | 非法 `Last-Event-ID` 的真实 400（typed `RESUME_CURSOR_INVALID`） |

## 重抓流程

```bash
python3 macos/scripts/capture-insight-fixtures.py            # 写入本目录
python3 macos/scripts/capture-insight-fixtures.py --out /tmp/x  # 复核漂移（与已落盘的 diff）
```

重抓后必须同步 `manifest.json` 的 `sha256` / `bytes` / `captured_at`，并在 PR 里写明新哈希。
