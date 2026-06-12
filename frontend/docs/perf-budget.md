# Performance Budget Workflow (BEL-39)

> **Status: SCAFFOLDING (Step A)** — workflow + config in place; thresholds are placeholders and will be filled in by Step B after BEL-33 ~ BEL-38 land.

## 阈值来源

由 `frontend/docs/perf-baseline-2026-06.md` 的"基线测量"驱动，不要在 PR review 中临时改数字。

```
initial_threshold = max(baseline * 1.2, target * 0.9)
```

## 文件清单

| 文件 | 作用 | 何时改 |
|------|------|--------|
| `frontend/.lighthouserc.json` | lhci 跑测配置 + 阈值断言 | Step B 跑完基线后回填阈值 |
| `.github/workflows/lighthouse-ci.yml` | PR/main 触发 Lighthouse 审计 | 改 trigger / 添加 manual dispatch |
| `frontend/docs/perf-baseline-2026-06.md` | 基线 + 测量方法 + 改进幅度 | 每次跑完跑测后更新 |
| `frontend/docs/perf-budget.md` | 本文件：流程说明 | 流程变更时 |

## Step A vs Step B 边界

**Step A（本 PR，scaffolding）**：
- 不依赖 BEL-33 ~ BEL-38 的代码合并
- 提交: `.lighthouserc.json` + workflow + docs 占位
- review 重点: 文件结构、跑测命令、阈值占位策略

**Step B（阻塞）**：
- 依赖 BEL-33 ~ BEL-38 全部 `done`
- 跑 `lhci autorun` 拿基线
- 回填 `lighthouserc.json` 真实阈值
- 故意退化 PR 验证 build fail
- 发布 `/docs/perf-baseline-2026-06.md` 终稿

## Reviewer 注意

- 当前 `lighthouserc.json` 里的数字（lcp 3000、tbt 300 等）是 placeholder，**不要**当成"已经同意的阈值"review
- workflow 的 `numberOfRuns: 3` + `temporary-public-storage` 会在每次 PR 产生公共链接（24h 过期），review 时可以打开对比
