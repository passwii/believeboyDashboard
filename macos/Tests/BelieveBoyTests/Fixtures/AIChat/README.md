# AI 会话片快照（BLF-1065）

「AI 智能 → AI Chat」与「客服交流」两页 12 条端点里**四条读响应 + 一套 SSE 事件序列**的真实
快照，用于把「与 Web 同源同结构」变成可执行断言（`AIChatDecodingTests` / `AIChatClientTests` /
`AIChatStoreTests` / `AIChatRenderingTests`）。

## 为什么必须是真响应

| 文件 | 手写会漏掉什么 |
| --- | --- |
| `ai-config.json` | 未配置 provider 时 `models` / `default_model` 是**空**的（`provider_configured: false` 是合法状态）——手写通常会给一组看着正常的模型名，于是「未配置」这条分支永远没人验 |
| `ai-conversations.json` | `datetime` 是带 offset 与小数的 ISO8601；字段名是 `total_prompt_tokens` 这类 snake_case |
| `ai-conversation-messages.json` | `search_sources` 的声明类型是 `list[dict[str, str \| float \| None]]`（**声明宽、实际窄**）：`score` 是数字、其余是字符串、老数据里可能缺键。手写只能证明「能解我自己编的形状」 |
| `ai-chat-stream-*.txt` | `id:` 游标是 Redis Stream entry id（`<ms>-<seq>`）、`data:` 的键名、以及**`done` 跟在 `message_stop` 后面**这条顺序事实 |
| `ai-usage-stats-30d.json` | `daily` 是**补 0 的 30 行**（不是只有有数据的天），`conversation_count` 是上界、`snapshot_freshness` 在物化表为空时是 `null` |

键名写错在 Swift 侧既不报错也不解码失败（Optional 属性静默 nil、非 Optional 整条报错），
所以这五份都必须是后端真正吐出来的东西。

## 抓取口径（`manifest.json` 里也逐项记着）

- **四条读端点**：本地后端经 FastAPI `TestClient` 走真实 HTTP 路由（`GET /ai/config`、
  `GET /ai/conversations`、`GET /ai/conversations/{id}/messages`、`GET /ai/usage/stats`），
  只发 GET、**不产生任何写请求**（不建会话、不发消息 —— 那会真花 AI 配额）。
- **鉴权**：`X-API-Key`（主 key）+ `X-Is-Admin: true` + `X-User-Id: 99001065`。
- **数据来源**：会话与消息是**生产快照库 `BLF` 里的真实数据**（一个含搜索来源的会话连同它的
  4 条消息）。`BLF` **只读** —— 脚本先把它们复制进可写的隔离库 `BLF_test`、挂在夹具账号下，
  再经真实路由读出来。
- 抓取时点 / 逐文件 `sha256` / 字节数：见 `manifest.json`。

### 为什么要跨两个库

读端点要**成对**才有意义（会话列表与消息历史必须来自同一个账号，否则「这条消息属于哪个会话」
无从断言）。而 `BLF` 的现状是：

- 归属 `user_id` 的会话（11~15）**一个消息都没有**；
- 有消息的会话（1 / 3 / 8 / 9）`user_id IS NULL`，而后端对这类历史脏数据**对任何调用方都返回
  404**（`services/ai/chat.py:65`）。

所以「同一账号 + 有消息」在 `BLF` 上不存在。脚本的做法是把真实会话复制进隔离库
（`BLF_test`，夹具账号 99001065 刻意避开 pytest 用的 42），再走真实路由 —— 内容来自生产快照，
读写都不落 `BLF`。脚本每次先删掉上次插入的那条（按标题前缀 `[BLF-1065 夹具]`），**幂等**。

### SSE 事件序列为什么不实跑一次流

要钉的是**线格式**（`id:` 游标、`data:` 键名、事件类型顺序），而这些正是编码器的输出：
`encode_sse`（`services/ai/protocol/encoder.py`）+ `_encode_done_sse`
（`endpoints/ai_chat_v2.py`）。三份文件里的事件实例都是真实的 `ProtocolEvent` 子类，`done`
载荷里的两条消息来自真实 `ai_messages` 行，`id:` 游标取自本地 Redis 真实 `XADD`（临时 key，
抓完即删）。

本机 `ai_chat_provider_*` 未配置（`provider_configured = false`），实跑起不来；更根本的是 LLM
正文**不确定** —— 把一次实跑的文本固化成「快照」等于给一份马上就会腐烂的文本背书，也与本批
口径 8「AI 文本不逐字断言」冲突。**分片由脚本给**（真实分片不可复现），但拼起来必须等于落库
正文，`AIChatDecodingTests.testAccumulatorRebuildsDraftFromSnapshot` 就断言这一点。

## 重新抓取

```bash
python3 macos/scripts/capture-ai-chat-fixtures.py                  # 写回本目录
python3 macos/scripts/capture-ai-chat-fixtures.py --out <dir>      # 写别处（复核漂移）
python3 macos/scripts/capture-ai-chat-fixtures.py --user-id <id>   # 换夹具账号
```

脚本需要 `backend/.env`（含 `DATABASE_URL`），且会在 import app **之前**把 `DATABASE_URL` 指向
隔离库；`BLF` 只被 `SELECT`。

重抓后**必须**同时更新 `manifest.json` 的 `sha256` / `bytes` / 计数与 `captured_at`，并在 PR 里
写明新的哈希 —— `AIChatDecodingTests.testCommittedSnapshotHashesMatchManifest` 会拦下不一致的
提交。

## 目录

| 文件 | 说明 |
| --- | --- |
| `ai-config.json` | `GET /ai/config`：未配置 provider 的真实形状（空模型列表） |
| `ai-conversations.json` | `GET /ai/conversations`：夹具账号的会话列表 |
| `ai-conversation-messages.json` | `GET /ai/conversations/{id}/messages`：4 条消息，含 `search_sources` |
| `ai-usage-stats-30d.json` | `GET /ai/usage/stats?range=30d`：30 天补 0 + 空的 `snapshot_freshness` |
| `ai-chat-stream-turn.txt` | 一次完整生成：`message_start → content_block_* → message_delta → message_stop → ping → done`（**`done` 在 `message_stop` 之后**） |
| `ai-chat-stream-resume.txt` | 续传帧：只有 `content_block_delta` + `message_stop`，**没有 `done`**（`_resume_stream` 只转发 Redis 原始帧） |
| `ai-chat-stream-error.txt` | `error` 事件（`rate_limit`） |

`ai-chat-stream-resume.txt` 是「`message_stop` 无 `done` 是合法收尾」这条判断的证据：桌面端会真发
续传请求，所以这条路径必须落成「已完成但没有持久化载荷」，而不是照 Web 那样当错误
（`AIChatDecodingTests.testResumeFramesWithoutDoneAreLegitimate`）。
