# Performance Baseline — June 2026 (BEL-39)

> **Status: SCAFFOLDING (Step A, BEL-39)**
> 实际数字待 Step B 跑完 `lhci autorun` 后回填。BEL-33 ~ BEL-38 全部 `done` 之前不要 publish 本文档的最终数字。

## Owner

- Issue: [BEL-39](https://github.com/passwii/believeboyDashboard/issues/39)
- 负责人: [@前端开发主管Seth](mention://agent/335e68d0-8b7b-461e-b8d8-dee19030cbd6)
- 协调: [@开发主管-Alpha](mention://agent/eea3d748-f903-432f-8239-48828027143f) (BEL-32 节奏 + BEL-37 启动)

## 测量方法

- 工具: [`@lhci/cli`](https://github.com/GoogleChrome/lighthouse-ci) v0.14.x
- 命令: `pnpm exec lhci autorun --config=frontend/.lighthouserc.json`
- 环境: 本地 `pnpm build && pnpm start`，4 个核心路由 × 3 次 run 取中位数
- Preset: `desktop`（项目主要是 dashboard 后台，mobile 不在本次范围）
- 设备模拟: Lighthouse 默认 Moto G Power throttle + 桌面 CPU slowdown 4×
- 数据时间: 待 Step B 启动时记录

## 路由覆盖

| 路由 | 业务场景 | 备注 |
|------|---------|------|
| `/` | 落地页/重定向 | |
| `/dashboard` | dashboard 主页 | sidebar + 图表首屏 |
| `/dashboard/data-analysis/ad-analysis/overview` | 业务高频页 | recharts 改造目标 |
| `/dashboard/data-reporting/monthly-report` | 业务高频页 | 已被选为 server/client 拆分样板 (BEL-33) |

## 6 项指标

| 指标 | 目标值 (BEL-39) | 基线 (占位) | 初始阈值 (占位) | 收紧后阈值 |
|------|----------------|------------|---------------|-----------|
| LCP | < 2500 ms | _TBD_ | _TBD_ | < 2500 ms |
| TBT | < 200 ms | _TBD_ | _TBD_ | < 200 ms |
| total-byte-weight | < 1200 KB | _TBD_ | _TBD_ | < 1200 KB |
| FCP | < 1800 ms | _TBD_ | _TBD_ | < 1800 ms |
| CLS | < 0.1 | _TBD_ | _TBD_ | < 0.1 |
| TTI | < 3800 ms | _TBD_ | _TBD_ | < 3800 ms |

> 目标值直接来自 BEL-39 描述。基线 / 初始阈值由 Step B 跑出后回填。

## 阈值公式

```
initial_threshold = max(baseline * 1.2, target * 0.9)
```

- 不会比基线差 20%（防止 build 必挂）
- 至少比目标值宽 10%（留两轮迭代收紧空间）
- 收紧紧路线: initial → 90% of initial → target

## 各子 issue 改进幅度

> 全部待 BEL-33 ~ BEL-38 落地后测量。

| Issue | 主要改动 | 预期影响 | 实测 delta |
|-------|---------|---------|-----------|
| BEL-33 | 胖 page server/client 拆分 | client chunk ↓ ≥ 15% | _TBD_ |
| BEL-34 | exceljs/jspdf/pdf-lib/docx 动态 import | 主 bundle 拆出 ~1MB+ | _TBD_ |
| BEL-35 | 字体限定字重 + display swap | 字体文件 ↓ ≥ 30% | _TBD_ |
| BEL-36 | recharts 懒加载 | 首屏 client 拆出 ~400KB | _TBD_ |
| BEL-37 | proxy timeout 分级 + 缓存 | 减少慢请求 → LCP/TBT | _TBD_ |
| BEL-38 | Sidebar memo + usePathname 下沉 | route 切换 0 sidebar commits | _TBD_ |

## CI 接入

工作流文件: `.github/workflows/lighthouse-ci.yml`（草稿，Step A 范围）

- 触发: PR + push to main
- 行为: build → start → lhci autorun → upload 到 `temporary-public-storage`
- 闸门: `assert.assertions` 任一项 `[error]` 失败即 build fail
- 备注: 当前 workflow 是占位骨架，PR review 时只审结构，不审阈值（阈值 Step B 才定）

## 故意退化验证（Step B 验收项之一）

- 提交一个故意超阈值的 PR（例如临时把字体 `weight` 改为全字重 import）
- 确认 CI workflow 真的 fail
- revert 后确认 pass
- 验证完后删除该 PR
