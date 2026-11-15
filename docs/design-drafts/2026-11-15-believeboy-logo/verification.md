# BLF-1553 验证记录

> 基于 `origin/main` @ `531a2a43`（2026-11-15 同步，rebase 后 `rev-list --left-right --count origin/main...HEAD` = `0 0`）。

## 前端测试

| 命令 | 结果 |
| --- | --- |
| `npx vitest run components/brand app/dashboard/brand-draft` | **4 文件 / 19 例通过** |
| `npx vitest run`（全量） | **401 文件 / 2948 例通过**，0 失败，69s |
| `pnpm lint` | **0 errors / 8 warnings**（8 条均在未触碰的存量文件里：`inventory-replenishment-client.tsx`、`return-analysis-client.tsx`、`seasonal-replenishment-client.tsx`、`weekly-product-analysis-client.tsx`、`display-client.tsx`、`image-preview-dialog.tsx`、`upload-zone.tsx`） |
| `pnpm build` | **exit 0**，`/dashboard/brand-draft` 出现在路由清单 |
| `npx tsc --noEmit` | 本次新增文件 **0 诊断**；仓库既有报错（`mobile-layout-contract.test.ts` 的 `s` flag、`ledger-glossary.test.tsx` 的 `period` prop）与本次无关 |

判档：本任务新增 `components/ui/liquid-glass-logo-reveal.tsx`（共享 `ui/` 目录的新组件）+ 新路由 →
按 T3 跑全量（上表第 2 行），未只跑目标集。

## 真实浏览器验证（Playwright + SwiftShader WebGL2）

草稿页不是静态图替换品 —— 下面每项都在真实组件上跑：

| 检查 | 结果 |
| --- | --- |
| `file://` 单文件打开 | 1 个 `<canvas>`，**0 console error / 0 pageerror** |
| 网络请求（非 `file:` / `data:`） | **0 条**（字体 base64 内嵌，无远程依赖） |
| `document.fonts.check('600 20px Manrope')` | `true`（字标字体真实加载） |
| 四个动效 tab 切换 | 每次重挂为 1 canvas；`wing-cut` / `prism` / `bare` / `上游默认` 都出画面 |
| 明暗切换 | `body` 背景 `rgb(236,238,241)` → `rgb(16,19,25)` |
| 放大 16px 检查 | 展开后 14/16/18/20 px × 6 的画面可见 |
| 方向切换 | A / B / C 三个 mark 都通过同一个玻璃管线重绘（B 的账本细线、C 的小写 b 都正确落地） |
| 关键帧页（`artifacts/blf-1553/frames/index.html`） | 7 个 canvas（`time` 冻结 7 档），0 报错；产出 `06-motion-keyframes.png` |
| `startZoom` 逐档对拍（2.0 / 2.4 / 3.2） | 15 个 canvas，0 报错；结论见 README「关键帧与一个实测出的参数陷阱」 |

## 抓到的真实 bug（不是样式口味问题）

1. **上游组件没有导出 `GlassIconReveal`** → 无法传入自定义 mark。已改为 `export`。
2. **`React.RefObject` 在 React 18 类型下只读** → `live.current = …` 编译报错。已改为 `MutableRefObject`。
3. **独立草稿页缺 Tailwind 定位类** → 组件的 `relative` wrapper 失效，绝对定位的 canvas 逃逸到整页，
   首屏只剩一张玻璃 + 页脚。已在 `draft.css` 补齐 `position: relative / isolation / overflow`。
4. **单文件合成时 `String.replace` 把 bundle 里的 `$&` 当替换模式** → 产出被截断、页面 `SyntaxError`。
   已改为函数式 replacer。

## 未验证 / 明确不做

- **没有**在真实登录页、侧栏、favicon、PWA 图标上接入 —— 这些是定稿后才做的事，草稿阶段不动已确认资产。
- **没有**在 Safari / Firefox 上验 WebGL2；只在 Chromium + SwiftShader 下验过。
- **没有**做手机视口验收；`design-spec.md` §0.4.2 的桌面范围不要求。
- **没有**测真实网络延迟下的首屏；草稿页是本地文件。
