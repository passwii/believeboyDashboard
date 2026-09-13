# BLF-1038：`/api/v1/daily-analysis/all` 结果缓存（Stage 5 性能改进）

> **状态：** 进行中（Stage 5，BLF-1033 拆分项）
> **风险：** [risk:normal]（纯读路径加缓存，无写路径语义变更；缓存失效沿用 L1 弱一致口径）

## 一、问题与验收

生产最慢接口：`/api/v1/daily-analysis/all` 每天 142 次慢日志（>800ms），
p50 = 1287ms / p90 = 2236ms / max = 13136ms，占每日请求量（~738）的 19%，每次全量重算。

验收（来自 issue）：

1. 部署后 `slow_request path=/api/v1/daily-analysis/all` 频次下降 > 90%；
2. 缓存命中路径 p90 < 300ms；miss 路径不劣于现状；
3. `cd backend && pytest` 全绿 + 新增缓存行为测试。

## 二、现状证据（本地 BLF 生产快照实测）

用 `backend/scripts/_bench_daily_all*.py`（临时脚本，不入库）在本地 BLF（与 prod 同数据量）实测：

| 指标 | 值 |
| --- | --- |
| 活跃项目数 | 10 |
| 查询数 | 79（≈ 8/项目：5 个 metric loader + 2 个 latest-date + 1 个 asin map） |
| DB 耗时 | 139ms（本地） |
| 服务层总耗时 | 230~425ms（本地） |
| 端到端（TestClient） | 230ms（本地 p50） |
| 响应体 | **3.43 MB**（5245 detail rows + 各项目 detail rows 重复一遍） |

prod p50 1287ms ≈ 本地 230ms 的 5.6 倍 → **DB + Python 聚合是 miss 路径主成本**。

前端有 4 个 hook 打这个接口：

- `app/dashboard/page.tsx`（当前区间 + 对比区间，页面加载/切筛选时各 1 次）
- `lib/hooks/use-portfolio-data.ts`（2 分钟客户端缓存）
- `lib/hooks/use-header-kpis.ts`（顶栏 KPI，**5 分钟轮询**，只读 `summary_rows`）
- `lib/hooks/use-seven-day-brief.ts`（Footer 快报，**5 分钟轮询**，只读 `summary_rows`）

这正是巡检里"一秒 4 次并发请求同一接口"的来源：不是重复请求，是 4 个不同 hook。

### 关键判断：纯 TTL 缓存（5min）不足以达成验收

前端轮询间隔 `TERMINAL_TICKER.pollIntervalMs = 5 * 60 * 1000` 与"5 分钟 TTL"同频，
下一次轮询恰好落在 TTL 边界附近：命中率在"几乎全命中"与"几乎全 miss"之间抖动
（取决于 1~2s 的计算耗时余量与 timer 漂移），一旦对齐到 miss 侧，
慢日志频次几乎不降 → 验收第 1 条达不成。

## 三、方案：SWR（stale-while-revalidate）快照缓存

读路径三级：

1. **冷启动（无快照）**：单飞（Redis `SET NX`）——抢到锁的请求同步计算 + 回填；
   未抢到的请求最多等 15s 读别人回填的快照（避免"一秒 4 连发"造成 4 份全量计算），
   等待超时则自己算（不写缓存，避免覆盖）。
2. **快照新鲜**（age ≤ 300s 且未被失效标记）：直接返回快照字节。
3. **快照过期**（age > 300s 或数据变更 epoch 更新）：**立即返回旧快照**，
   并在 `BackgroundTasks` 中异步刷新（单飞锁），请求路径不等重算。

数据新鲜度上界：TTL 软新鲜期 5 分钟 + 前端 5 分钟轮询 ⇒ 展示数据最多约 10 分钟旧；
数据本身是 T+1 报告 + 上传即时失效，验收允许（issue 原文："T+1 级新鲜度即可接受"）。

**失效时机**：`invalidate_daily_analysis_cache(project_id)`（所有上传/船期写路径已在调用）
额外写一个全局 `data-epoch` 时间戳；快照 `computed_at < epoch` 即视为过期 →
下一次读取立刻后台刷新。因为聚合快照跨多项目，按 project 无法用 key 前缀收敛，
用 epoch 标记（1 个 key、1 次 SET）比模式删更便宜也更安全（不会出现"删了却没人回填"）。

### 为什么缓存序列化后的字节（而不是 dict）

命中路径若缓存 dict，每次仍要 `json.loads`(3.4MB) + Pydantic 校验 + FastAPI 序列化，
prod（≈ 本地 5.6 倍）下这段开销就可能顶穿 300ms。缓存**已序列化字节**后命中路径 =
1 次 Redis GET + zlib 解压 + 直接 `Response(bytes)`，Pydantic/FastAPI 序列化全部跳过。

代价是"响应模型变了而缓存体还是旧形状"，用 **schema 指纹进 key** 解决：
`DailyAnalysisAllProjectsResponse.model_json_schema()` 的 md5 前 8 位作为 key 的一部分，
模型一改 key 自动变更，旧体自然不再命中（不需要人工 bump 版本号）。
冷启动写缓存前先 `model_validate` 一次，保证写进 Redis 的体一定合当前 schema。

### 顺带精简：`_load_latest_available_dates` 全量行 → SQL 聚合

该函数此前把项目下 3 种 report_type 的 `(report_date, period_start_date, snapshot_at)`
**全量行**（单项目 ~450 行、10 项目 ~4400 行）拉回 Python 只为求 4 个最大值，
是同路径"行数/收益比"最差的一处。改为 `max(...) filter (...)` 下推 SQL（返回 1 行 3 列），
语义逐条对齐（sales→`max(report_date)`；business→`max(period_start_date)`；
inventory→`max(coalesce(report_date, snapshot_at::date))`，`max()` 天然忽略 NULL，
与 Python 端 `report_date or snapshot_at.date()` 后取 max 等价）。

## 四、明确不做（留 issue 备注）

- **跨项目批量查询**（79 查询 → ~12）：收益集中在 miss 路径，而 SWR 后冷 miss 极少；
  改动 4 个 loader 模块的语义风险 > 收益，留作后续（若 miss 路径仍需优化）。
- **载荷精简 `include_detail=false`**（3.43MB → ~20KB，顶栏 KPI / Footer 快报其实只要
  `summary_rows` + `project_breakdown`）：需要前端配合改 2~4 个 hook，交前端评估（issue 已约定通知前端）。
- 响应 gzip 中间件：会引入每请求压缩 CPU，与本 issue"降 CPU"目标相悖，另议。

## 五、落地清单

- `backend/app/services/infra/cache.py`：新增快照缓存区（key / 读 / 写 / 新鲜度 / epoch / 单飞锁）。
- `backend/app/schemas/daily_analysis.py`：`serialize_all_projects_response()` + schema 指纹。
- `backend/app/api/v1/endpoints/daily_analysis.py`：端点接入 SWR（含后台刷新任务）。
- `backend/app/services/daily/analysis.py`：`_load_latest_available_dates` 聚合下推。
- 测试：`tests/api/test_daily_analysis_all_cache.py`（命中/冷启动单飞/过期后台刷新/失效标记/key 幂等/体可被响应模型解析）
  - `tests/services/daily/test_daily_latest_available_dates.py`（聚合等价 + NULL 分支）。

## 六、验收对照

| 验收 | 本方案如何达成 |
| --- | --- |
| 慢日志 -90% | 命中与"过期命中"都是字节直出（< 100ms 量级）；只有冷启动/新 key 才同步重算 |
| 命中 p90 < 300ms | 无 DB、无 Python 聚合、无 Pydantic/FastAPI 序列化 |
| miss 不劣于现状 | 冷启动仍走原路径；另额外减少 4400 行/次的行扫描 |
| pytest 全绿 | 新增 2 个测试文件 + 存量 `test_daily_analysis_all_sentinel.py`（改后需回归） |
