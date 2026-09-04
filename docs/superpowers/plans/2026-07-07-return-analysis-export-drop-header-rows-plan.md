# 退货分析导出 Excel 去掉每 sheet 表头两行 实现计划

> **面向 AI 代理的工作者：** 步骤使用复选框（`- [ ]`）语法跟踪进度。所有改动集中在 1 个文件，共 11 处编辑。

**目标：** 删除 `frontend/app/dashboard/data-analysis/return-analysis/page.tsx` 中 5 个 sheet 的标题行 + 元信息行，列名行从第 3 行移到第 1 行；冻结窗从 `ySplit: 3` 改为 `ySplit: 1`；同步清掉随之失去用途的 `addTitleAndMeta` helper、`exportedAt`、`sheetMeta` 变量。

**架构：** 单文件、纯导出布局调整。不动后端 API、不动数据库、不动其它页面导出逻辑、不动 Excel 库、不动样式工具函数（`applyHeaderBorder` / `applyBorder` 仍由列名行调用）。

**技术栈：** Next.js + React + TypeScript + ExcelJS（动态 import）。

**规格文档：** [`docs/superpowers/specs/2026-07-07-return-analysis-export-drop-header-rows-design.md`](../specs/2026-07-07-return-analysis-export-drop-header-rows-design.md)

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 修改 | `frontend/app/dashboard/data-analysis/return-analysis/page.tsx` | 删除 `addTitleAndMeta` helper + `exportedAt` + `sheetMeta`；删除 5 个 sheet 的 helper 调用；调整 5 处 `styleHeaderRow` 行号 + 5 处 `ws.views.ySplit` |

---

## 任务清单

### 任务 1：删除 helper 与失去用途的变量

**文件：** `frontend/app/dashboard/data-analysis/return-analysis/page.tsx`

- [ ] **步骤 1：删除 `exportedAt` 与 `sheetMeta`（line 353-359）**

  删除以下整段（共 7 行）：
  ```ts
  const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })
  const sheetMeta = {
    project: data.project_name,
    country: data.country,
    start: data.start_date,
    end: data.end_date,
  }
  ```

- [ ] **步骤 2：删除 `addTitleAndMeta` helper（line 373-407）**

  删除整个 helper 定义（共 35 行，从 `const addTitleAndMeta = (` 到对应闭合 `}`）。

  删除后，`styleHeaderRow`（line 362-371）保留——它仍被列名行调用。

### 任务 2：调整 5 个 sheet 的调用与样式/冻结参数

每个 sheet 都有 3 处需要改：① 删除 `addTitleAndMeta(...)` 调用；② `styleHeaderRow(ws, 3)` → `styleHeaderRow(ws, 1)`；③ `ySplit: 3` → `ySplit: 1`。

- [ ] **步骤 3：调整「退货排行」sheet**

  - 删除 line 421：`addTitleAndMeta(ws, '退货排行', data.ranking_rows.length, headers.length)`
  - 改 line 424：`styleHeaderRow(ws, 3)` → `styleHeaderRow(ws, 1)`
  - 改 line 444：`ySplit: 3` → `ySplit: 1`

- [ ] **步骤 4：调整「退货原因」sheet**

  - 删除 line 454：`addTitleAndMeta(ws, '退货原因分析', data.reason_rows.length, headers.length)`
  - 改 line 457：`styleHeaderRow(ws, 3)` → `styleHeaderRow(ws, 1)`
  - 改 line 470：`ySplit: 3` → `ySplit: 1`

- [ ] **步骤 5：调整「商品状态」sheet**

  - 删除 line 480：`addTitleAndMeta(ws, '商品状态分布', data.disposition_rows.length, headers.length)`
  - 改 line 483：`styleHeaderRow(ws, 3)` → `styleHeaderRow(ws, 1)`
  - 改 line 496：`ySplit: 3` → `ySplit: 1`

- [ ] **步骤 6：调整「库存状态」sheet**

  - 删除 line 506：`addTitleAndMeta(ws, '库存状态分布', data.status_rows.length, headers.length)`
  - 改 line 509：`styleHeaderRow(ws, 3)` → `styleHeaderRow(ws, 1)`
  - 改 line 522：`ySplit: 3` → `ySplit: 1`

- [ ] **步骤 7：调整「顾客反馈」sheet**

  - 删除 line 532：`addTitleAndMeta(ws, '顾客反馈列表', data.feedback_rows.length, headers.length)`
  - 改 line 535：`styleHeaderRow(ws, 3)` → `styleHeaderRow(ws, 1)`
  - 改 line 549：`ySplit: 3` → `ySplit: 1`

### 任务 3：构建与回归验证

- [ ] **步骤 8：TypeScript 类型检查**

  在 `frontend/` 目录下跑：
  ```bash
  pnpm tsc --noEmit
  ```
  预期：无非预期报错（如果有报错，确认是本次改动导致的，并修复——常见原因可能是删除 helper 后某行变量未对齐缩进）。

- [ ] **步骤 9：手动回归测试**

  按规格文档「手测回归（必做）」5 步执行：
  1. 进入 `dashboard/data-analysis/return-analysis?project=1`；
  2. 选择任意项目 + 任意国家 + 任一非空日期区间；
  3. 点击「导出 Excel」下载；
  4. 打开下载文件，逐 sheet 检查：第 1 行 = 中文列名（粗体灰底居中），第 2 行起 = 数据，无大字标题、无元信息行；
  5. 滚动任一数据多的 sheet，确认列名行始终钉在顶部。

- [ ] **步骤 10：commit + 提交**

  按仓库约定写 commit：
  ```text
  fix(return-analysis): 导出 Excel 去掉每个 sheet 的标题与元信息两行
  ```

---

## 回滚

单次 commit、单文件改动。`git revert <commit>` 即可完全回退，无连带影响。

## 风险

- 列名行号改错：5 处 `styleHeaderRow(ws, 3) → 1` 必须同步完成——任务 2 已逐 sheet 列出。
- 冻结参数漏改：5 处 `ySplit: 3 → 1` 必须同步完成——同上。
- 其它页面导出被误改：本计划明确只动 return-analysis；不改其它文件。