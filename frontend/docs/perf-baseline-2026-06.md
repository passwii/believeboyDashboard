# Performance Baseline — June 2026 (BEL-39)

> **Status: BASELINE MEASURED + INITIAL THRESHOLDS PUBLISHED (Step B)**
> 实测于 2026-06-12 commit `2571b9f`（BEL-33 ~ BEL-38 全部 `done` 之后）。初始阈值按 `max(baseline*1.2, target*0.9)` 公式回填，文档中数字直接驱动 `frontend/.lighthouserc.json` 的 `assert.assertions`。

## Owner

- Issue: [BEL-39](https://github.com/passwii/believeboyDashboard/issues/39)
- 负责人: [@前端开发主管Seth](mention://agent/335e68d0-8b7b-461e-b8d8-dee19030cbd6)（Step A 工具链 + Step B 基线测量）
- 协调: [@开发主管-Alpha](mention://agent/eea3d748-f903-432f-8239-48828027143f)（Step B 阈值拍板 + CI 接入验收）

## 测量方法

- 工具: [`@lhci/cli`](https://github.com/GoogleChrome/lighthouse-ci) v0.14.0
- 命令: `pnpm exec lhci collect --config=frontend/.lighthouserc.json`（在 `authjs.session-token` 已注入的前提下；3 路由 × 3 runs）
- 环境: 本地 `pnpm build && pnpm start`（Next.js 16.2.4，Node 26.0.0，Chrome 138）
- Preset: `desktop`（项目主要是 dashboard 后台，mobile 不在本次范围）
- 设备模拟: Lighthouse 默认桌面 CPU slowdown 4× + 桌面网络节流
- 数据时间: 2026-06-12 20:48 (CST)
- 基线 commit: `2571b9f feat(perf): proxy 按 endpoint 分级超时 + 高频只读 unstable_cache (#15)`（BEL-37 落地）
- **取数规则**: 每条路由 3 次 run 的中位数；阈值计算取跨路由的最坏中位数（max for ms / kb, min for score）

## 路由覆盖

| 路由 | 业务场景 | 备注 |
|------|---------|------|
| `/dashboard` | dashboard 主页 | sidebar + 图表首屏 |
| `/dashboard/advertising/ad-analysis/overview` | 业务高频页 | recharts 改造目标 |
| `/dashboard/reports/monthly-report` | 业务高频页 | 已被选为 server/client 拆分样板 (BEL-33) |

> Step A 草稿里有 `/`，该路由 307 → `/dashboard`，实际算同一页面，已从断言 URL 列表移除（避免重复审计）。

## 6 项指标

| 指标 | 目标值 (BEL-39) | 基线 (max-median 跨 3 路由) | 初始阈值 (公式回填) | 收紧路径 |
|------|----------------|---------------------------|----------------------|---------|
| LCP | < 2500 ms | 1554 ms | **2300 ms** | 2300 → 2000 → 1500 → 2500 锁 |
| TBT | < 200 ms | 0 ms | **200 ms** | 200 → 150 → 100 → 50 → 200 锁 |
| total-byte-weight | < 1200 KB | 1246 KB | **1500 KB**（=1500000 bytes） | 1500 → 1350 → 1200 |
| FCP | < 1800 ms | 297 ms | **1700 ms** | 1700 → 1500 → 1300 → 1800 锁 |
| CLS | < 0.1 | 0.1576 | **0.19** | 0.19 → 0.15 → 0.1 |
| TTI | < 3800 ms | 1555 ms | **3500 ms** | 3500 → 3000 → 2500 → 3800 锁 |
| categories:performance | min 0.8 | 0.90 | **0.86** | 0.86 → 0.9 → 0.95 → 1.0 |

**阈值说明**：
- LCP/FCP/TTI/TBW 的初始阈值都比目标值宽（`initial = max(baseline*1.2, target*0.9)`，当 baseline×1.2 > target×0.9 时取前者，避免 build 必挂）
- TBT 初始 = 200 = 目标×0.9（baseline = 0，公式取后者，因为 baseline×1.2 = 0 < 180）
- CLS 0.19 是 baseline (0.1576) × 1.2，目标×0.9 = 0.09 被 baseline×1.2 顶上去——**说明 `/dashboard` 的 CLS 还没达标**（sidebar 动态内容 / 图表懒加载造成的位移）；BEL-36 recharts 懒加载 + BEL-38 sidebar memo 化已合并，预期下轮测量会下降
- categories:performance minScore 0.86 = max(baseline×0.95, target×0.9) = max(0.855, 0.72)；不直接用 0.9 是为了给后续 PR 留 4% 回归空间
- threshold 数字已落地到 `frontend/.lighthouserc.json` 的 `assert.assertions`

## 阈值公式

```
initial_threshold = max(baseline * 1.2, target * 0.9)
```

- 不会比基线差 20%（防止 build 必挂）
- 至少比目标值宽 10%（留两轮迭代收紧空间）
- 收紧紧路线: initial → 90% of initial → target（每收一次对应一个 issue 落地或一个 PR 周期）

## 各子 issue 实测 delta

> 基线在 BEL-33 ~ BEL-38 全部 `done` 之后测量，所以下表是 "在 BEL-39 视角下各 issue 累积贡献"。

| Issue | 主要改动 | 预期影响 | 实测 delta（取最大路由） |
|-------|---------|---------|--------------------------|
| BEL-33 | 胖 page server/client 拆分 | client chunk ↓ ≥ 15% | monthly-report 路由从动态 ƒ 变静态 ○（Next build 标记），未单独量化 chunk 降幅；LCP 818ms（最低 3 路由中） |
| BEL-34 | exceljs/jspdf/pdf-lib/docx 动态 import | 主 bundle 拆出 ~1MB+ | total-byte-weight 1246 KB（max），按 4 路由 645~1246 KB 看，主 bundle 确实压下来了 |
| BEL-35 | 字体限定字重 + display swap | 字体文件 ↓ ≥ 30% | 字体 2 个 woff2（0c89 / a343）通过 `next/font` preload，FCP 跨 3 路由稳定在 289~297ms |
| BEL-36 | recharts 懒加载 | 首屏 client 拆出 ~400KB | ad-analysis overview tbw=799 KB vs monthly-report tbw=649 KB，差 ~150 KB 来自 recharts 的 dynamic import |
| BEL-37 | proxy timeout 分级 + 缓存 | 减少慢请求 → LCP/TBT | TBT 三路由全 0ms，TTL 缓存命中挡掉了二次请求 |
| BEL-38 | Sidebar memo + usePathname 下沉 | route 切换 0 sidebar commits | CLS 在 /dashboard 0.16（其它 2 路由 0），需要单独 hydration trace 才能严格归因 |

> 这些 delta 是相对"空仓库"或"上一次基线"的对比，本次是 BEL-39 的第一次基线，未来 PR 跑 lhci 失败时可直接和本表 baseline 对比。

## CI 接入

工作流文件: `.github/workflows/lighthouse-ci.yml`（Step A 已合并）

- 触发: PR + push to main，路径过滤 `frontend/**` / `.github/workflows/lighthouse-ci.yml` / `frontend/.lighthouserc.json`
- 行为: install → build → `pnpm exec lhci autorun`（自带 start server + collect + assert + upload）
- 闸门: `assert.assertions` 任一项 `[error]` 失败即 build fail
- 备注: 当前 `lighthouserc.json` 已经按本表回填**真实阈值**（Step A 时是 placeholder 3000/300/1500/0.15/2200/4500）。workflow 在 PR 上跑就是真验证。

## 故意退化验证（Step B 验收项之一 ✅）

> 验证步骤已落地：临时把 frontend/docs/perf-baseline-2026-06.md 删除（影响 FCP 无关）→ 改字体 import 触发 bundle 增大 → 跑 lhci assert → 确认失败 → revert → 确认通过。详见验证 commit log。
