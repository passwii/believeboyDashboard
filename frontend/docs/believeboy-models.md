# 彼励扶 Believeboy 模型选型方案

**归档位**：`teamRock/BBCC-彼励扶基础设施/彼励扶_Believeboy模型选型方案.md`

**最后更新**：2026-07-07

**归属**：BBCC · 彼励扶基础设施 / 模型选型

---

## 0. 摘要

本文档汇总彼励扶（Believeboy）系列大模型的规格与定位，以表格形式直观对比各档位模型在 **名称 / 架构 / 大小 / 上下文 / 背后模型** 五个维度的差异，便于在算力选型、推理部署、对外展示时快速查阅。

> **说明**：截至本文档撰写时，部分旗舰型号（Ultra）的参数尚未敲定，文档中以 **其他参数暂无** 或 **暂无模型** 占位，待后续补全后回写。

---

## 1. 模型对比表

| 名称 | 架构 | 大小 | 上下文 | 背后模型 |
|------|------|------|--------|----------|
| Believeboy-Ultra | MOE | 1T | 其他参数暂无 | 暂无模型 |
| Believeboy-Max | MOE | 550B-A55B | 1000K | NVIDIA Nemotron 3 Ultra |
| Believeboy-Pro | MOE | 295B-A21B | 256K | tencent-Hy3 |
| Believeboy-Plus | MOE | 120B-A12B | 1000K | NVIDIA Nemotron 3 Super |
| Believeboy-Mini | DENSE | 31B | 256K | Google Gemma 4 31B |
| Believeboy-Nano | MOE | 30B-A3B | 256K | NVIDIA Nemotron 3 Nano |

> 注：Believeboy-Max 参数已补全，Believeboy-Ultra 仍待补全具体参数。

---

## 2. 字段说明

| 字段 | 取值约定 | 示例 |
|------|---------|------|
| **名称** | 模型代号，Ultra / Max / Pro / Plus / Mini / Nano 由大到小排列 | `Believeboy-Pro` |
| **架构** | `MOE`（Mixture of Experts，混合专家） / `DENSE`（稠密） | `MOE`、`DENSE` |
| **大小** | 总参数量 + 激活参数量（`-AxxB` 表示激活量），单位 `B`（十亿） / `T`（万亿）；`N/A` 表示参数暂未敲定 | `550B-A55B` = 总 550B、激活 55B |
| **上下文** | 上下文窗口长度，单位 `K`（千 token）；未披露写 `N/A` 或 `其他参数暂无` | `256K`、`1000K` |
| **背后模型** | 基于/参考的底层模型；`暂无模型` 表示尚未确定 | `NVIDIA Nemotron 3 Ultra`、`Poolside Laguna M.1` |

---

## 3. 选型速览

- **旗舰档（待补全参数）**：Ultra —— `1T` 级 MOE，作为对外演示 / 高复杂度任务的主力候选
- **企业级**：Max（`550B-A55B` / `1000K`）、Pro（`295B-A21B` / `256K`） —— 长上下文 + 大激活量，适合复杂推理与多文档分析
- **主力档**：Pro（`295B-A21B` / `256K`） —— 智力和水平的平衡，推荐作為默认选型
- **性价比档**：Plus（`120B-A12B` / `1000K`） —— 轻量级企业级任务候选
- **轻量档**：Mini（`31B DENSE` / `256K`） —— 唯一稠密模型，低显存 / 端侧 / 边缘部署候选
- **极致轻量**：Nano（`30B-A3B` / `256K`） —— MOE 低激活量，适合对吞吐与成本敏感的场景

---

## 4. 待补全

- [ ] Believeboy-Ultra 的上下文窗口、激活量、背后模型等具体参数
- [ ] 是否补充「发布时间 / 训练 token 数 / 许可证 / 推荐部署硬件」等扩展列

> 参数一旦确认，回写本表并同步更新第 2 节「字段说明」。
