# 图标资源说明

`gui/crates/gui-app/assets/icons/` 下的 SVG 图标来源与许可：

- **Lucide 图标**（43 个，如 layout-dashboard / store / trending-up 等）：
  - 来源：https://lucide.dev （`lucide-react` v0.577.0 提取的原始路径数据；
    GUI-6 新增的 6 个 loader / info / circle-check / triangle-alert / circle-x / close
    取自 lucide 官方仓库 `icons/*.svg`，同 ISC 许可）
  - 许可：**ISC License**（Copyright (c) for portions of Lucide）
  - 原版权声明与许可文本：https://github.com/lucide-icons/lucide/blob/main/LICENSE
  - 提取方式：读取 `lucide-react/dist/esm/icons/*.js` 的 `__iconNode` 数据，渲染为
    `viewBox="0 0 24 24"`、`stroke="currentColor"`、`stroke-width="2"` 的标准 SVG。
- **ai.svg**（自定义，1 个）：
  - 消息气泡 + 星芒的 AI 标识，替代 frontend 的 `ChatGptIcon`（品牌组件不复制）。

> 维护约定：frontend sidebar 图标变化时，在此目录增删对应 SVG 并同步
> `src/assets.rs`（ICON_PATHS + include_bytes 表）与 `src/icon.rs`（key 映射）。
