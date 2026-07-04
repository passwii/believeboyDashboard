# Fonts (未入 Git)

本目录下的字体文件**不入 git**(见仓库根 `.gitignore`)。

## 为什么

- `NotoSansSC-Regular.otf` 完整文件约 16 MB,会显著膨胀仓库历史
- 只被 `frontend/app/dashboard/special/markdown-to-word/lib/markdown-pdf.ts:122`
  运行时通过 `fetch('/fonts/NotoSansSC-Regular.otf')` 拉取(运行时 fetch,不进 bundle)
- Next.js 把整个 `public/` 当作静态资产服务,所以本目录文件**仍会被部署平台
  (Vercel 等)打包到生产构建产物中**,只是不进 git 历史

## 如何获取

### 选项 A:从 Google Fonts 下载(推荐)

```bash
# macOS 用 curl(Google Fonts 静态资源,直链可能变动,以官网为准)
curl -L -o frontend/public/fonts/NotoSansSC-Regular.otf \
  https://github.com/notofonts/noto-cjk/raw/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf
```

或访问 <https://fonts.google.com/noto/specimen/Noto+Sans+SC> → "Download family"
解压后取 `NotoSansSC-Regular.otf` 放入本目录。

### 选项 B:从 Adobe Source Han Sans 转

```bash
# Source Han Sans = Noto Sans CJK 的 Adobe 命名
# https://github.com/adobe-fonts/source-han-sans/releases
```

## 验证

```bash
ls -la frontend/public/fonts/
# 应该看到 NotoSansSC-Regular.otf(本地,不入 git)
git status frontend/public/fonts/
# 应该显示 "nothing to commit"(如果文件已就位)或仅显示 README
```

## 切到 next/font(可选优化)

如果不再需要运行时 fetch(例如改用 `next/font/google` 自动子集化),
可以删除本目录文件并改造 `markdown-pdf.ts` 的字体获取逻辑。Next.js 13+
内置 `next/font/google` 支持 `Noto_Sans_SC`,build 时自动子集化到 ~350KB。