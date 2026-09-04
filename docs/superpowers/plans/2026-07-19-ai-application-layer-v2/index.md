# AI 应用层 V2 · P1 实现计划(索引)

> **状态：** ✅ 已完成(2026-07-21)
> **分支：** `feat/ai-app-layer-v2-p1`
> **日期：** 2026-07-19
> **Spec：** [`docs/superpowers/specs/2026-07-19-ai-application-layer-redesign-v2-design.md`](../../specs/2026-07-19-ai-application-layer-redesign-v2-design.md)
> **Spike：** `openSourceProjects/ai-app-layer-spike/`(8/8 测试通过)

---

## 入口表

| 文档 | 说明 |
|---|---|
| [`2026-07-19-ai-application-layer-v2.md`](./2026-07-19-ai-application-layer-v2.md) | 主 plan(P1 任务总览 + 文件改动总览 + 执行顺序) |

## Phase 进度表

| Phase | 文档 | 范围 | 状态 | 估时 |
|---|---|---|---|---|
| A | [`-phase-a-protocol-layer.md`](./2026-07-19-ai-application-layer-v2-phase-a-protocol-layer.md) | 协议层:ProtocolEvent + encoder + ErrorCode | ✅ 完成 | 3-4 天 |
| B | [`-phase-b-orchestrator.md`](./2026-07-19-ai-application-layer-v2-phase-b-orchestrator.md) | 编排器:StreamRunner + RedisStreamBus + CancelRegistry + agent.iter | ✅ 完成 | 5-7 天 |
| C | [`-phase-c-endpoint-frontend.md`](./2026-07-19-ai-application-layer-v2-phase-c-endpoint-frontend.md) | 端点重写 + 前端 protocol codec + useChatStream | ✅ 完成 | 5-7 天 |
| D | [`-phase-d-migration-tests.md`](./2026-07-19-ai-application-layer-v2-phase-d-migration-tests.md) | 删除旧代码 + e2e 补全 + 文档更新 | ✅ 完成(e2e + 文档;旧代码删除留 P2) | 3-4 天 |

**总估时：** 3-4 周(实际 2 天完成核心实现)

## Git tag 清单

- `v2-p1-protocol` — Phase A 完成(协议层)
- `v2-p1-orchestrator` — Phase B 完成(编排器)
- `v2-p1-endpoint` — Phase C 完成(端点 + 前端)
- `v2-p1-complete` — Phase D 完成(e2e + 文档)

## 外部关联

- **设计 spec：** `docs/superpowers/specs/2026-07-19-ai-application-layer-redesign-v2-design.md`
- **V1 spec(已被取代)：** `docs/superpowers/specs/2026-07-17-ai-chat-architecture-redesign-design.md`
- **Spike 验证：** `openSourceProjects/ai-app-layer-spike/`
- **开源参考：** `openSourceProjects/pydantic-ai-stream/`(opale-ai,核心参考)

## 数据快照

- **Commits:** 8(Phase A: 3, Phase B: 1, Phase C: 2, Phase D: 2)
- **Tests:** 67 passed(protocol 33 + orchestrator 27 + e2e 5 + encoder 8)
- **Files:** 14 新增(backend 10 + frontend 2 + tests 2)
- **Lines:** ~2,400 新增(backend ~1,800 + frontend ~600)
