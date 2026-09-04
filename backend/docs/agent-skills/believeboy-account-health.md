---
name: believeboy-account-health
description: 调用 BelieveBoy Agent API 获取跨项目店铺合规健康数据（account-health 域，business_scope account_health，5 条纯读路由，路径不带 project_id）。用于合规巡检周期列表/当前周期/概览/单店报告/历史趋势。Use when the user asks for 店铺合规健康 / account health / 合规巡检 / 账号健康 / 店铺体检, 或任何需要从 dash-api.believeboy.com 读取合规健康数据的任务。
---

# BelieveBoy Agent API · 店铺合规健康（account-health）

跨项目店铺合规健康（巡检）数据读取方法。**凭据不在此文件中**——每次调用从环境变量读取（agent custom_env 注入），禁止把 Key 明文写进本 skill、回复或任何文档。

## 0. 凭据来源与鉴权（每次请求缺一不可）

> **workspace env 变量名约定（统一）**：`AGENT_KEY`（明文 Key）/ `AGENT_ID`（X-Agent-Id 业务主键）/ `API_BASE`（Base URL，可省略走默认）。各 agent 的 custom_env 按此三件套配置，skill 内一律引用这三个名字，禁止硬编码/明文 Key。

```bash
KEY="${AGENT_KEY}"                  # 明文 Key，agent custom_env 注入
AGENT_ID="${AGENT_ID}"              # X-Agent-Id 业务主键，如 operator-manager-Damon
BASE="${API_BASE:-https://dash-api.believeboy.com/api/v1/agent}"
AUTH=(-H "Authorization: Bearer $KEY" -H "X-Agent-Id: $AGENT_ID")
```

## 1. 项目名 → ID 解析（派发只给项目名，先查 ID）

```bash
curl -s "$BASE/projects?name=<项目名>" "${AUTH[@]}"
# → {"ok":true,"data":[{"project_id":1,"project_name":"<项目名>"}]}
PROJECT_ID=$(curl -s "$BASE/projects?name=<项目名>" "${AUTH[@]}" | jq -r '.data[0].project_id')
```

项目名以系统为准（共 13 个），未命中先向派发方确认，不猜。

## 2. 端点目录（5 条纯读，business_scope "account_health"）

> ⚠️ **路径结构特殊**：本域除 R4 外**不带 `/projects/{project_id}` 路径段**——前缀为 `/api/v1/agent/account-health/*`，项目范围过滤在 handler 内按 agent key 的 project_scope 做（对齐 report-upload-status 语义）。

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| R1 | GET | `/account-health/periods` | 周期列表（复用 inspection_service.list_periods，纯读零改造） |
| R2 | GET | `/account-health/periods/current` | 当前周期（纯读，不建行） |
| R3 | GET | `/account-health/periods/{period_id}/overview` | 周期概览（状态推导 / 逾期口径） |
| R4 | GET | `/account-health/periods/{period_id}/projects/{project_id}` | 单店报告明细 |
| R5 | GET | `/account-health/history` | 历史趋势（与内部 /inspections/history 同构查询） |

```bash
# 周期列表（先看有哪些巡检周期）
curl -s "$BASE/account-health/periods" "${AUTH[@]}"

# 当前周期概览
curl -s "$BASE/account-health/periods/current" "${AUTH[@]}"

# 指定周期 + 指定项目的单店报告
curl -s "$BASE/account-health/periods/{period_id}/projects/$PROJECT_ID" "${AUTH[@]}"
```

## 3. 注意事项

- 纯读域：读路由不落审计；限流读 300 次/分
- 数据底座直接复用巡检数据（S2 结论：零新增表/迁移，inspection_periods / inspection_reports）
- **5xx**：一次性报告给报告 owner（Yawei），不要盲目重试
- 404 与空列表是设计；挂 `require_business_scope("account_health")`
- 完整 spec：`docs/superpowers/specs/2026-08-08-agent-account-health-api.md`（模块 `backend/app/api/v1/endpoints/agent/account_health.py`）
