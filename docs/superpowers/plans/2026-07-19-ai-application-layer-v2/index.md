# AI 应用层 V2 · P1 实现计划(索引)

> **状态：** 🔄 进行中
> **分支：** 待创建(feature/ai-app-layer-v2-p1)
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
| A | [`-phase-a-protocol-layer.md`](./2026-07-19-ai-application-layer-v2-phase-a-protocol-layer.md) | 协议层:ProtocolEvent + encoder + ErrorCode | ⬜ 未开始 | 3-4 天 |
| B | [`-phase-b-orchestrator.md`](./2026-07-19-ai-application-layer-v2-phase-b-orchestrator.md) | 编排器:StreamRunner + RedisStreamBus + CancelRegistry + agent.iter | ⬜ 未开始 | 5-7 天 |
| C | [`-phase-c-endpoint-frontend.md`](./2026-07-19-ai-application-layer-v2-phase-c-endpoint-frontend.md) | 端点重写 + 前端 protocol codec + useChatStream | ⬜ 未开始 | 5-7 天 |
| D | [`-phase-d-migration-tests.md`](./2026-07-19-ai-application-layer-v2-phase-d-migration-tests.md) | 删除旧代码 + e2e 补全 + 文档更新 | ⬜ 未开始 | 3-4 天 |

**总估时：** 3-4 周

## Git tag 清单

(实施后补充)

## 外部关联

- **设计 spec：** `docs/superpowers/specs/2026-07-19-ai-application-layer-redesign-v2-design.md`
- **V1 spec(已被取代)：** `docs/superpowers/specs/2026-07-17-ai-chat-architecture-redesign-design.md`
- **Spike 验证：** `openSourceProjects/ai-app-layer-spike/`
- **开源参考：** `openSourceProjects/pydantic-ai-stream/`(opale-ai,核心参考)

## 数据快照

(实施完成后补充:commit 数 / 测试数 / 文件数)
