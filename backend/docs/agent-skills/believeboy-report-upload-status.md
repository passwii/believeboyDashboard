---
name: believeboy-report-upload-status
description: 调用 BelieveBoy Agent API 获取报表上传状态（report_upload_status 域，business_scope report_upload_status，1 条读路由 GET /report-upload-status，路径不带 project_id）。用于 RPA 报表状态矩阵（哪些项目/报表缺报）、每日缺报清单。Use when the user asks for 报表上传状态 / 缺报 / 报表状态 / report upload status, 或任何需要从 dash-api.believeboy.com 读取报表上传状态的数务。
---

# BelieveBoy Agent API · 报表上传状态（report-upload-status）

跨项目报表上传状态（缺报矩阵）读取方法。**凭据不在此文件中**——每次调用从环境变量读取（agent custom_env 注入），禁止把 Key 明文写进本 skill、回复或任何文档。

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

## 2. 端点（1 条读路由，business_scope "report_upload_status"）

`GET /api/v1/agent/report-upload-status`（BLF-484，与内部 `/api/v1/rpa-reports/status` 同构 + summary）；**report_date 必填**（缺省 → 400）

> ⚠️ **路径不带 `/projects/{project_id}`**——项目范围过滤在 handler 内按 agent key 的 project_scope 做（对齐 account-health 语义）。

```bash
# 报表上传状态矩阵（含 summary）
curl -s "$BASE/report-upload-status" "${AUTH[@]}"

# 指定业务日期
curl -s "$BASE/report-upload-status?report_date=2026-08-10" "${AUTH[@]}"
```

**用途**：BLF-486「报表状态跟进 Agent」（每日缺报清单早报）的核心数据源——判断哪些项目/报表类型未上传。

## 3. 注意事项

- 纯读域：读路由不落审计；限流读 300 次/分
- **5xx**：一次性报告给报告 owner（Yawei），不要盲目重试
- 404 与空列表是设计；挂 `require_business_scope("report_upload_status")`
- 完整契约：believeboyDashboard `docs/agent-api-design.md` v0.4 + OpenAPI（模块 `backend/app/api/v1/endpoints/agent/report_upload_status.py`）
