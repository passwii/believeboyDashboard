# BLF-1018 · Insight 观测期质量 / 成本门禁 · Plan 索引

> **状态：** ✅ 交付（PR 待合并；legacy 退役**未执行**，等三票齐备）
> **分支：** `agent/damon/blf-1018` → `main`
> **日期：** 2026-09-12

## 一、入口

| 文档 | 内容 |
|------|------|
| [主 plan](./2026-09-12-blf-1018-insight-observation-gate.md) | 交付形态、关键判断、验证结果、后续阶段 |
| [运行文档 `INSIGHT_OBSERVATION_GATE.md`](../../../INSIGHT_OBSERVATION_GATE.md) | 观测字段与锚点、门禁阈值、删除清单、切换时间窗、回滚开关、负责人 |

## 二、阶段进度

单阶段交付（Stage 5 后端），无子 phase。

| 项 | 状态 | 主题 |
|----|------|------|
| 观测表 + 指标服务 | ✅ | `insight_run_observations`（迁移 `271`）+ `observation.py` |
| 传输/终态计数 | ✅ | `stream_bus.py`、`sink.py`、`insight_runs.py`、`celery_tasks/insights/run.py` |
| 并发/成本闸门 | ✅ | canonical run 补 `insights` 桶闸门，与 legacy `ai_summary` 分桶 |
| 降级打点 | ✅ | `ai_schedule_report.py`、`celery_tasks/ai_summary.py` |
| 只读端点 | ✅ | `GET /api/v1/insight/observation/{gate,retirement-readiness}`（管理员级） |
| 门禁脚本 | ✅ | `backend/scripts/insight_gate.py` |
| 测试 | ✅ | `tests/insight/test_observation.py` 33 + `test_quality_gate_scenarios.py` 10 |

## 三、Git tag

无（沿用仓库既有发布方式，本阶段不打 tag）。

## 四、外部关联

- 父 issue BLF-1005（Stage 5 = BLF-1018）；前端退役面 BLF-1017（Seth）。
- 运行文档：`INSIGHT_OBSERVATION_GATE.md`（仓库根，与 `SCHEDULED_REPORTS_INFRASTRUCTURE.md` 同级）。
- 迁移：`backend/alembic/versions/20260912_271_insight_run_observations.py`。

## 五、数据快照

| 指标 | 数值 |
|------|------|
| 新增后端文件 | 6（模型 / 迁移 / 指标服务 / schema / 端点 / 脚本） |
| 改动后端文件 | 11 |
| 新增测试 | 43（33 + 10） |
| `tests/insight` 全量 | 172 passed |
| 门禁脚本冒烟 | 空窗口 → exit 1；单行样本 → exit 0 |
