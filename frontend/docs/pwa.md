# PWA 安装入口

## 行为

- 手机与平板访问 dashboard 时展示安装入口。
- 桌面端不展示入口，也不注册 service worker。
- Android / Chromium 使用 `beforeinstallprompt` 的安装按钮。
- iOS Safari 不支持脚本触发安装，展示「分享 → 添加到主屏幕」指引。
- 已从主屏幕启动时不展示入口。
- 关闭后仅当前浏览器会话不再展示。

## 实现

- `app/manifest.ts`：应用名称、启动地址、standalone 模式和图标。
- `public/pwa/`：192 / 512 普通图标与 512 maskable 图标。
- `public/sw.js`：只接管同源导航请求并原样放行，不缓存页面、接口或登录态数据。
- `lib/pwa/device.ts`：手机 / 平板与 iOS Safari 判定。
- `components/pwa/pwa-install-prompt.tsx`：安装入口、iOS 指引与 service worker 注册。
- `app/layout.tsx`：在 hydration 前捕获 `beforeinstallprompt`，避免事件早于 React 挂载而丢失；桌面端同样拦截默认提示，因此不会回退到浏览器自动安装条。

## 验证

```bash
cd frontend
pnpm exec vitest run lib/pwa/device.test.ts components/pwa/pwa-install-prompt.test.tsx
pnpm lint
pnpm build
```

浏览器验收需使用 HTTPS（或 localhost）；生产域名已满足该前提。
