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

## P2b — 运行时聚合(已全部完成)

- [x] **端点(2026-09-05,由前端 agent 直接实现——用户指令:不走 Multica 全部本地交付)**:`GET /api/v1/agent-ops/domain-summary?days=7`(API key 鉴权 `protected`,前端代理附加主 key,不占 agent key 配额),对 `agent_api_audit_log` 按域聚合:

```json
{
  "generated_at": "…",
  "window_days": 7,
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

- 聚合口径:`calls = count(*)`、`writes = count(*) FILTER method IN (POST/PUT/PATCH/DELETE)`、`errors = count(*) FILTER status_code >= 400`;无调用的域不返回条目(前端以注册表补全);`operation_type IS NULL`(未映射流量)不返回;
- [x] **索引确认(2026-09-05)**:7 天窗口走既有 `idx_aaal_created_at` range scan;`(operation_type, created_at)` 复合索引与本查询形态(时间范围过滤 + 分组,无 operation_type 等值条件)不匹配,**不新增迁移**;
- [x] **前端(已预埋,2026-09-05)**:`lib/hooks/use-agent-domain-summary.ts`(挂载拉取,404/出错降级 `data = null`)+ 总览矩阵加三列(最近活动新鲜度灯:绿 <24h / 黄 1-7d / 灰 >7d 或从未,每日巡检域黄灯即需人工介入;24h/7d 调用量 tooltip 含写侧;7d 错误率有错着警色),端点未上线时全部占位「—」,交付后零前端改动自动点亮。

## P2c — 可选增强(产出列已交付,告警联动待端点上线)

- [x] **今日产出列(2026-09-05)**:总览矩阵加「今日产出」列,走**既有业务端点**(与 domain-summary 部署无关,上线即亮):
  - 客诉中心:`GET /complaints/overview?date=美西今天` → `待回复 N`(无巡检 run 占位);
  - 平台巡检 / 店铺合规(读侧):`GET /inspections/periods/current` + `/periods/{id}/overview` → `已提交/总数 报告`(两跳);
  - 报表上传 / 状态:`GET /rpa-reports/status?date=美西今天&country=US` → `M/N 报表`(复用 `reduceUploadStatus`);
  - 载体:`lib/hooks/use-agent-production.ts`(三子源独立降级,fetcher ref 稳定化防重拉)+ `productionCell` 纯函数;页头刷新(`useHeaderRefresh`)一并接入;
- [ ] **告警联动**:每日巡检域 >24h 无写入 → 告警中心 / 侧栏红点(复用 `use-alert-stats` 模式);依赖 domain-summary 在 VPS 上线后取真实 last_active_at,可再预埋;
- [ ] **写侧产出扩面**:其余域(SDK / 测算 / SKU)如需产出口径,逐域接业务计数(当前以活动列 + 写侧 tooltip 覆盖)。

## 明确不做

- 不搬 B 档页面(总览页给行 + 跳转即归集);不动 B 档页面 URL;
- 不重复 logs tab 明细能力(总览页只做聚合,明细链到接入管理 logs);
- 本 plan 零 agent API 契约变更(新增的是管理员面端点,`[risk:normal]`)。

## 验证

- P2a + P2b 前端预埋:lint / vitest(hook 纯函数 + 总览页两态 + sidebar 守卫)/ build 全绿;
- P2b 后端:Damon 端 pytest 覆盖聚合口径;前端列自动点亮(零改动)。

## 交接(2026-09-05 起全部本地交付,不走 Multica)

- 前端 + 后端均由前端 agent 直接实现并本地验证;pytest 集成测试因本机无 Postgres 未跑,随部署流水线与有 DB 环境补验;
- P2c 按价值另立 plan。
