# Agent 中心 · 员工段(P3)— 花名册与员工活动

> 前置:Phase 1(侧栏分组)+ P2(数据流总览,P2a 静态矩阵 / P2b 域活动聚合端点 /
> P2c-1 今日产出列)均已交付,见
> [2026-09-05-agent-dataflow-overview](../2026-09-05-agent-dataflow-overview/2026-09-05-agent-dataflow-overview.md)。
>
> 2026-09-05 命名清理:客诉中心页面更名「客户消息」(Customer Message),URL
> 不变;本 plan 起统一使用新名。

**Goal:** 补全 Agent 中心「员工 → 产出 → 接入」叙事的第一段——**员工**。凭据即身份
(`agent_api_keys`):把凭据花名册升格为「Agent 员工」页,叠加按 key 聚合的活动数据
(谁最近在干活、干多少、有没有出错),与总览页(产出段)、接入管理(运维段)形成完整产品线。

**Architecture:** 复用既有 admin 凭据 API(`listAgentApiKeys`)+ 新增一个与
domain-summary 同构的聚合端点(`employee-summary`,按 `api_key_id` 分组);前端
client-side join。零 schema 变更、零迁移。

## 分期

### P3a — 员工花名册页(前端)

- [ ] 新页 `/dashboard/agent-center/employees`(page + client + test);
- [ ] 数据源:`listAgentApiKeys()`(existing)→ 员工(label + agent_id)/ 能力域
      (`formatBusinessScope`)/ 项目范围 / 状态(激活/停用/已过期/已吊销)/ 最近使用;
- [ ] 侧栏 Agent 中心组第二项「Agent 员工」+ `dashboard-route-meta`;

### P3b — 员工活动聚合(后端 + 前端接线)

- [x] **端点(2026-09-05)**:`GET /api/v1/agent-ops/employee-summary?days=7`
      (`protected`,与 domain-summary 同族),对 `agent_api_audit_log` 按
      `api_key_id` 分组(`api_key_id IS NOT NULL`——匿名/master/skip 流量不计入
      任何员工):

```json
{
  "generated_at": "…",
  "window_days": 7,
  "items": [
    {
      "api_key_id": 3,
      "calls_24h": 12,
      "calls_7d": 89,
      "writes_24h": 2,
      "writes_7d": 14,
      "errors_7d": 0,
      "last_active_at": "2026-09-05T12:34:56Z"
    }
  ]
}
```

- [x] **测试**:`backend/tests/api/test_agent_ops_employee_summary.py` ——
  聚合口径 / NULL api_key_id 排除 / days 边界 / 401(复用 `make_api_key`
  fixture 播种凭据 + 直插 audit 行);
- [ ] **前端**:`use-agent-employee-summary` hook(挂载拉取 + 失败降级)→ 花名册
  加运行时列(24h/7d 调用、7d 错误、最近活动新鲜度灯),与 `listAgentApiKeys`
  按 `api_key_id` join;从未活动的员工活动列显示「—」。

### P3c — 远期(不在本 plan)

数字员工人格化(人设 / 头像 / 任务分派 / 运行态):等数字员工实做推进后,
`digital-employees` 从 AI 组迁入 Agent 中心并与花名册合流。

## 明确不做

- 不动接入管理的凭据 CRUD(运维动作留在运维页);员工页只读;
- 不做按员工告警(先看 P2c 告警联动的价值);
- 零迁移、零 agent key 契约变更。

## 验证

- 后端:pytest(employee-summary 与 domain-summary 同构用例);本机无 Postgres,
  以 import 检查 + SQLite 依赖覆盖端到端脚本兜底(与 P2b 同法);
- 前端:eslint + vitest(花名册渲染 / join 逻辑 / 降级占位)+ build。

## 部署

- 前端随 push 由 Vercel 自动部署;
- 后端改动已推 origin/main,**按用户指令暂不部署 VPS**,过几天由用户手动
  `python productEnvAgent/deploy_vps.py --auto`;端点上线前员工活动列降级占位。
