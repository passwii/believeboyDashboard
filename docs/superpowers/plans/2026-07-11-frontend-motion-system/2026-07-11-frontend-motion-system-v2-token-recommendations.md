# Motion System v2 Token 优化建议（调研报告）

> **调研时间：** 2026-07-12
> **调研输入：** Phase 0-8 commit history + v1 token 使用密度（grep）
> **调研输出：** v2 token 优化建议清单
> **状态：** ⏳ 待用户决策 — **不实际改 token**，仅输出建议

---

## 调研方法

```bash
cd frontend
# JS 侧使用密度
grep -rn "DURATION\.\|EASE\.\|SPRING\.\|STAGGER\.\|Z\." --include="*.ts" --include="*.tsx" | grep -v test

# CSS 侧使用密度（var(--motion-*), var(--z-*), var(--stagger-step), var(--spot-*))
grep -rn "var(--motion-\|var(--z-\|var(--stagger-step)\|var(--spot-" --include="*.css" --include="*.tsx" --include="*.ts" | grep -v ".next"
```

按下列指标分类每个 token：
- **JS 引用次数**（仅 ts/tsx，排除 test 与 node_modules）
- **CSS 引用次数**（仅 globals.css + UI 组件，排除 .next 缓存）
- **是否对齐**：JS 与 CSS 引用次数是否都 > 0

---

## v1 Token 使用密度总表

| Token | JS 引用 | CSS 引用 | 对齐状态 | 备注 |
|-------|---------|----------|----------|------|
| DURATION.fast | 0 | 29 | ⚠️ 错位 | JS 未用；CSS 高频（hover/focus 微状态） |
| DURATION.base | 4 | 8 | ✅ 对齐 | MotionFade / MotionStagger / variants × 2 |
| DURATION.slow | 0 | 4 | ⚠️ 错位 | JS 未用；CSS 用于 sheet 退出动效 |
| DURATION.springPress | 1 | 2 | ✅ 对齐 | notification-toast 用 + .u-press / switch 组件 |
| EASE.out | 4 | 36 | ✅ 对齐 | 主缓动曲线；高频 |
| EASE.standard | 0 | 14 | ⚠️ 错位 | JS 未用；CSS 用于 panel 退出 + 各种 keyframe |
| EASE.springBack | 0 | 0 | 🗑️ 双重未用 | 既无 JS 引用也无对应 CSS 单独定义（曲线同 --motion-spring-press） |
| SPRING.page | 3 | 0 | ✅ 仅 JS | Normal/FullBleed PageTransition + variants |
| SPRING.press | 0 | 0 | 🗑️ 双重未用 | 无引用 |
| STAGGER.step | 0 | 1 | ⚠️ 错位 | JS 未用；CSS 仅 .u-stagger-item 用一次 |
| STAGGER.childDelay | 2 | 0 | ✅ 仅 JS | MotionStagger + variants.ts |
| Z.nav | 0 | 0 | 🗑️ 双重未用 | 全栈未引用 |
| Z.overlay | 0 | 0 | 🗑️ 双重未用 | 全栈未引用 |
| Z.modal | 0 | 0 | 🗑️ 双重未用 | 全栈未引用 |
| Z.toast | 0 | 0 | 🗑️ 双重未用 | 全栈未引用 |
| Z.grain | 0 | 0 | 🗑️ 双重未用 | 全栈未引用 |
| isReducedMotionDefault | 0 | — | ℹ️ 占位 | 运行时应通过 framer-motion `useReducedMotion()` 读 |

> 注：上面计数均**排除** `tokens.ts` 顶部注释表格中的引用（这些只是文档）。
> 严格来说，注释中的 markdown 表格也算 "1 次" 出现，但不计入"生产使用"。

---

## 关键发现

### 发现 1：JS / CSS 严重错位（DURATION.fast / .slow / EASE.standard / STAGGER.step）

现状：
- JS 侧 4 个 token **生产代码 0 引用**：`DURATION.fast`、`DURATION.slow`、`EASE.standard`、`STAGGER.step`
- CSS 侧同 4 个 token **高频使用**：`--motion-fast` (29)、`--motion-slow` (4)、`--motion-ease-standard` (14)、`--stagger-step` (1)

含义：
- 这些 token **不是真的没用**，而是 **JS 镜像缺失实际调用**。它们被 CSS utility（`.u-interactive`、`.hover-lift`、`.conversation-item` 等）大量消费。
- JS 端定义它们是为 **CSS 端的文档镜像**（让工程师知道 CSS 值对应 JS 命名）。
- **双侧同步纪律**依然有效：改任一侧都需同步另一侧。

### 发现 2：`EASE.springBack` / `SPRING.press` 双重未用

- `EASE.springBack` 曲线 `[0.34, 1.56, 0.64, 1]` 与 `--motion-spring-press` 完全相同；
  但 JS 端 **没有调用** `EASE.springBack`，所有 spring 场景都用 `DURATION.springPress + ease: 'easeOut'` 字符串（如 `notification-toast.tsx:62`）。
- `SPRING.press` 是 framer-motion spring 物理参数，**全栈无引用**。

含义：
- 这两个是 **"为未来场景预留"**，但 Phase 0-8 没有场景落地。
- v2 决策需要：**保留作为 API 完备性** 还是 **删除以减少认知负担**？

### 发现 3：Z.* 五个 token 全栈未引用

- `Z.nav (30)` / `Z.overlay (50)` / `Z.modal (60)` / `Z.toast (70)` / `Z.grain (80)` 在 `tokens.ts` 与 `globals.css` 中都定义了。
- 但 **全仓库 0 引用**（grep `Z\.nav|var(--z-nav)` 等）。

含义：
- 这是 Phase 0 的 "替代散落 z-10/50/9999" 目标 — 当时只定义了 token，未做迁移。
- Phase 0-8 改动了 z-index，但**没用 token**（直接写 `z-50`、`z-[60]` 等 Tailwind class）。

### 发现 4：`STAGGER.step` 与 `STAGGER.childDelay` 值相同

- 都是 `0.07`，对应 `--stagger-step`。
- 实际只有 `STAGGER.childDelay` 在 `MotionStagger.tsx` 与 `variants.ts` 用到。
- `STAGGER.step` 是 **占位镜像**（与 CSS token 名对应），但 JS 端无消费。

含义：
- 是不是 **冗余定义**？可以合并为一个 `STAGGER.step`（同时给 staggerChildren 用）。

---

## 优化建议（待用户决策）

### 建议 1：删除 `EASE.springBack`

- **理由**：与 `--motion-spring-press` 曲线完全相同；JS 端 0 引用；保留仅为概念完整。
- **替代**：需要 spring 曲线时直接用 `ease: 'easeOut'` + `DURATION.springPress`，或新增 `EASE.springPress` 同值别名（更明确语义）。
- **风险**：如果未来 toast / dialog / drawer 改用 `EASE.springBack`，需要重新加回。
- **建议**：**采纳删除**，待有需求再回加。

### 建议 2：删除 `SPRING.press`

- **理由**：全栈 0 引用；与 `SPRING.page` 概念重复（都是 spring 物理）；用户决策时容易困惑 "该用哪个"。
- **替代**：需要时直接定义 `{ type: 'spring', stiffness: ..., damping: ..., mass: ... }` 字面量。
- **建议**：**采纳删除**，待有需求再回加。

### 建议 3：合并 `STAGGER.step` + `STAGGER.childDelay`

- **理由**：值相同（都是 0.07）；`STAGGER.step` 仅作为 CSS token 镜像存在，但 JS 端不需要单独的 "step"。
- **替代**：保留 `STAGGER.step`（删 `childDelay`），所有 `staggerChildren` 都用 `STAGGER.step`。
- **建议**：**采纳合并**，只保留 `STAGGER.step`。

### 建议 4：JS 端补齐使用 `DURATION.fast` / `DURATION.slow` / `EASE.standard`

**反面论证**：让 JS 端也消费这些 token，强化 "JS 镜像" 的事实，避免后续漂移。

**具体方案**：
- 检查 variants.ts 是否有 hardcoded 数字（如 280ms、60ms）→ 替换为 `DURATION.base` / `STAGGER.step`
- 检查 `.dashboard-surface` 类的 utility className 中是否还有 `duration-200` / `duration-300` Tailwind class → 替换为 token

**不建议的理由**：
- v1 token 已经覆盖了 JS 端**实际需要的语义**（fade、stagger、page transition、spring press）
- CSS 端的 utility class（`.u-interactive`、`.hover-lift` 等）是更便捷的封装，不应在 JS 端重复定义 `transition={{ duration: DURATION.fast }}`

**建议**：**保持现状**，不强求 JS 端覆盖 CSS token；让 JS / CSS 各自服务不同抽象层。

### 建议 5：Z.* 五档标尺的处理

**方案 A：删除**
- 理由：全栈 0 引用；保留是死代码。
- 风险：未来需要统一 z-index 体系时重新定义。

**方案 B：迁移现有 z-index 使用到 token**
- 范围：grep `z-10\|z-50\|z-[60]\|z-[70]`（实际可能有 z-50 之类的 Tailwind class）。
- 工作量：可能 5-20 处改动（dashboard panel、toast、modal、sheet、sidebar 等）。
- 收益：z-index 标尺统一，避免散落 magic number。

**建议**：**采纳方案 B**（迁移），但作为独立 PR（不在 Phase 9 范围内）。Phase 9 仅输出建议，不实施。

### 建议 6：是否新增场景化 SPRING.modal / SPRING.toast？

**当前实现**：
- toast 进出用 `DURATION.springPress (0.22s) + ease: 'easeOut'` 字符串（`notification-toast.tsx:62`）
- modal / sheet 进出用 CSS keyframe + Tailwind class（`animate-in` / `animate-out`）
- drawer 暂未实现

**是否需要场景化 spring**：
- 如果 toast / modal 都用同一个 spring，那不需要。
- 如果想让 toast 更"急促"（短 + 脆），modal 更"沉稳"（长 + 软），就需要拆分。

**建议**：**保持现状**（toast 用 springPress，modal 用 CSS keyframe）。新增场景时再考虑场景化 token，避免过早抽象。

---

## 用户决策项

| # | 决策项 | 推荐方案 | 替代方案 | 工作量 |
|---|--------|---------|---------|--------|
| 1 | 删除 EASE.springBack？ | ✅ 删除 | 改名 EASE.springPress 保留 | 1 行修改 + 测试更新 |
| 2 | 删除 SPRING.press？ | ✅ 删除 | 保留作为 API 完整 | 1 行修改 + 测试更新 |
| 3 | 合并 STAGGER.step + childDelay？ | ✅ 合并 | 保留两个 | 2-3 处替换 |
| 4 | Z.* 五档是否迁移？ | ⏸ 后续独立 PR | 立即删除 / 立即迁移 | 独立 PR 评估 |
| 5 | 是否新增场景化 SPRING？ | ⏸ 不新增 | 立即新增 SPRING.modal/toast | — |

---

## 调研局限

1. **未检查 Radix 组件内**：很多 Radix wrapper（sheet.tsx、dialog.tsx、tooltip.tsx 等）使用 Tailwind `data-[state=open]:animate-in` 类的预设动画，未走我们的 token 体系。v2 可考虑覆盖 Radix 预设。
2. **未检查 Storybook / 设计端**：项目当前无 Storybook / Figma Variables 同步，调研无法触达设计端使用情况。
3. **未检查 E2E 测试**：Playwright 测试覆盖动效视觉，但 token 频率统计未纳入。

---

## 后续

- 用户决策后，由子任务实施（如"v2 清理 EASE.springBack + SPRING.press + STAGGER.childDelay"）。
- Z.* 迁移如决定做，建议作为独立 Phase 10。
- 不在本 Phase 9 范围。