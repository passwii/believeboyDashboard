# 图标资源说明

`gui/crates/gui-app/assets/icons/` 下的 SVG 图标来源与许可：

- **Lucide 图标**（51 个，如 layout-dashboard / store / trending-up 等）：
  - 来源：https://lucide.dev （`lucide-react` v0.577.0 提取的原始路径数据；
    均取自 lucide 官方仓库 `icons/*.svg`，同 ISC 许可）：
    - GUI-6 新增 6 个：loader / info / circle-check / triangle-alert / circle-x / close
    - GUI-9 新增 6 个：arrow-up / arrow-down / minus / sort-ascending / sort-descending / chevrons-up-down
    - GUI-7 新增 2 个：chevron-up / chevron-down（minus 由 GUI-9 提供，不重复添加）
    - BLF-712 新增 3 个：mail / lock / eye（登录窗口表单：前缀图标 + 密码显隐）
  - 许可：**ISC License**（Copyright (c) for portions of Lucide）
  - 原版权声明与许可文本：https://github.com/lucide-icons/lucide/blob/main/LICENSE
  - 提取方式：读取 `lucide-react/dist/esm/icons/*.js` 的 `__iconNode` 数据，渲染为
    `viewBox="0 0 24 24"`、`stroke="currentColor"`、`stroke-width="2"` 的标准 SVG。
- **ai.svg**（自定义，1 个）：
  - 消息气泡 + 星芒的 AI 标识，替代 frontend 的 `ChatGptIcon`（品牌组件不复制）。
- **logo.svg**（自定义，1 个，BLF-712）：
  - 登录窗口 AppIcon 图块的白色图形层（上升柱状图 + 趋势箭头），几何与
    `gui/scripts/make-icon.py` 的 `draw_bars` 完全一致（1024 画布）；
    蓝色渐变圆角方块底由登录视图用 gpui `linear_gradient` 绘制，亮暗两态一致。

> 维护约定：frontend sidebar 图标变化时，在此目录增删对应 SVG 并同步
> `src/assets.rs`（ICON_PATHS + include_bytes 表）与 `src/icon.rs`（key 映射）。
