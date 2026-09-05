# Agent 中心 · 数据流总览页 — Phase 2 规划

> Phase 1(侧栏「Agent 中心」分组)已完成,见
> [2026-09-05-agent-center-sidebar](../2026-09-05-agent-center-sidebar/2026-09-05-agent-center-sidebar.md)。
> 本 plan 覆盖 Phase 2:总览页(P2a 前端骨架 / P2b 后端聚合 / P2c 增强)。

**Goal:** 建 `/dashboard/agent-center/overview` 总览页,把 `agent_api_audit_log`(已在自动记录每个 agent 调用:域 / 项目 / 国家 / 状态码 / 延迟,保留 90 天)从明细流水升级为域级健康矩阵,成为 Agent 中心「产出」段入口与未来所有 Agent 数据流的归集点。

**Architecture:** 前端数据源 = `AGENT_DOMAINS` 注册表(单一事实源,新增域自动出现);运行时聚合 = 后端 domain-summary 端点(一条 GROUP BY 查询)。前端单频道降级范式(仿 `use-report-upload-status`)。

## 现状盘点(2026-09-05)

| 已有 | 形态 | 缺口 |
|------|------|------|
| `agent_api_audit_log` + audit 中间件 | 每请求一行,`operation_type` = 业务域 code | 无按域聚合展示 |
| 接入管理页 overview tab | 16 域静态卡片 | 纯注册表,无运行时数据 |
| 接入管理页 logs tab | 读/写审计明细列表 | 明细而非健康总览 |
| 报表自动化页 + footer 完成度频道 | 15 类报表 × 项目矩阵 | 仅报表域 |

## P2a — 静态矩阵 + 跳转(纯前端,已完成)

- [x] `lib/agent-domains.ts`:注册表加 `dashboardPath?: string`(17 域中 16 个有前端入口,finance_profit 规划中无页面);
- [x] 新页 `app/dashboard/agent-center/overview/`(page + client + test):域级矩阵(业务域 / 说明 / 能力 / 路由 / 接入状态 / 入口),产出域置顶呼应侧栏叙事,规划中沉底;
- [x] 侧栏 Agent 中心组首项「数据流总览」+ `dashboard-route-meta` 标题。

## P2b — 运行时聚合(后端 Damon,量很小)

- [ ] **端点**:`GET /api/v1/agent-ops/domain-summary?days=7`(管理员会话鉴权,不走 agent key),对 `agent_api_audit_log` 按域聚合:

```json
{
  "generated_at": "…",
  "items": [
    {
      "domain": "complaint_center",
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

- 聚合口径:`calls = count(*)`、`writes = count(*) FILTER method IN (POST/PUT/DELETE)`、`errors = count(*) FILTER status_code >= 400`;无调用的域可不返回(前端以注册表补全);
- [ ] **索引确认**:`(operation_type, created_at)` 是否覆盖聚合查询;
- [ ] **前端**:hook(单频道降级)+ 矩阵加列:最近活动(新鲜度灯:绿 <24h / 黄 1-7d / 灰 >7d 或从未;每日巡检域黄灯 = 需要人工介入)、24h/7d 调量、错误率。

## P2c — 可选增强(按 P2b 上线后价值决定)

- 写侧产出列逐域接业务计数(报表完成度 M/N 现成;客诉 / 巡检有列表端点可 count);
- 告警联动:每日巡检域 >24h 无写入 → 告警中心 / 侧栏红点(复用 `use-alert-stats` 模式)。

## 明确不做

- 不搬 B 档页面(总览页给行 + 跳转即归集);不动 B 档页面 URL;
- 不重复 logs tab 明细能力(总览页只做聚合,明细链到接入管理 logs);
- 本 plan 零 agent API 契约变更(新增的是管理员面端点,`[risk:normal]`)。

## 验证

- P2a:lint / vitest(新增 client 测试 + sidebar 守卫测试)/ build 全绿;
- P2b:Damon 端 pytest 覆盖聚合口径;前端矩阵列渲染 + 降级占位测试。

## 交接(前后端,BLF-555)

- 前端(Seth):P2a 已交付并本地验证;P2b 契约如上,待后端端点就绪后接线;
- 后端(Damon):P2b 两项(聚合端点 + 索引确认),需求以 issue 评论为准。
