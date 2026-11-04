# 组件级设计阶段

> 状态：V4 Warm Ledger 已投入生产；后续组件晋升以真实第二消费者为前提。
>
> 原则：组件级设计只写本目录，不改 `frontend/`，不改全局 `--term-*`。

## 目标

把整页草稿拆成可复用、可评审、可接实现的组件设计稿。

每个 batch 固定交付：

- `spec.md`：用途、真实复用证据、API/内容契约、状态与桌面契约。
- `states.html`：可交互状态画廊。
- `assets/`：断点截图。
- 自检：键盘、focus、长内容、loading、empty、error、desktop geometry。

## 启动条件

1. 整页方向确认。
2. B0 基础契约冻结。
3. 每个 batch 只写自己的目录。
4. 组件不直接接入生产代码。

## 文件

- `registry.md`：组件清单、复用级别、真实验证证据。
- `plan.md`：B0–B7 批次、依赖与验收。
- `rollout.md`：生产推广顺序、flag、页面批次，以及 DeepSeek Max 实施 / Luna Max 审阅分工。
