# Markdown 转 Word 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在特殊功能分类下新增“Markdown 转 Word”页面，支持上传 Markdown 文件、粘贴 Markdown 内容、右侧实时预览，并在前端本地生成下载 DOCX 文件。

**架构：** 采用纯前端方案：页面组件负责交互状态，独立工具函数负责 Markdown 到 DOCX 的轻量转换，预览使用现有 `react-markdown` 与 `remark-gfm`。内容不上传后端。

**技术栈：** Next.js 14 App Router、React 18、Tailwind CSS、shadcn/ui、`react-markdown`、`remark-gfm`、`docx`。

---

### 任务 1：新增 DOCX 转换与下载工具

**文件：**
- 创建：`frontend/app/dashboard/special/markdown-to-word/lib/markdown-docx.ts`

- [ ] **步骤 1：编写最小可验证行为**

在实现前确认 `docx` 依赖不存在：

```bash
cd frontend && rg -n '"docx"|docx@' pnpm-lock.yaml package.json
```

预期：无匹配结果。

- [ ] **步骤 2：安装 DOCX 依赖**

```bash
cd frontend && pnpm add docx
```

预期：`package.json` 与 `pnpm-lock.yaml` 新增 `docx` 依赖。

- [ ] **步骤 3：实现工具函数**

```ts
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx'

export function markdownToDocxParagraphs(markdown: string): Paragraph[] {
  const normalized = markdown.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  return normalized.split('\n').map((line) => {
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 3)
      return new Paragraph({
        text: headingMatch[2].trim(),
        heading:
          level === 1 ? HeadingLevel.HEADING_1 :
          level === 2 ? HeadingLevel.HEADING_2 :
          HeadingLevel.HEADING_3,
      })
    }

    if (/^[-*+]\s+/.test(line)) {
      return new Paragraph({
        text: line.replace(/^[-*+]\s+/, ''),
        bullet: { level: 0 },
      })
    }

    if (/^\d+\.\s+/.test(line)) {
      return new Paragraph({
        text: line.replace(/^\d+\.\s+/, ''),
        numbering: { reference: 'default-numbering', level: 0 },
      })
    }

    return new Paragraph({
      children: [new TextRun({ text: line })],
      alignment: AlignmentType.LEFT,
    })
  })
}

export async function createMarkdownDocxBlob(markdown: string, filename: string): Promise<Blob> {
  if (!markdown.trim()) {
    throw new Error('Markdown 内容为空，无法生成 Word 文件')
  }

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: markdownToDocxParagraphs(markdown),
      },
    ],
  })

  return Packer.toBlob(doc, filename)
}
```

- [ ] **步骤 4：静态验证工具文件**

```bash
cd frontend && pnpm lint
```

预期：`markdown-docx.ts` 无 TypeScript/ESLint 错误。

---

### 任务 2：新增 Markdown 转 Word 页面

**文件：**
- 创建：`frontend/app/dashboard/special/markdown-to-word/page.tsx`
- 创建：`frontend/app/dashboard/special/markdown-to-word/markdown-to-word-client.tsx`
- 创建：`frontend/app/dashboard/special/markdown-to-word/lib/markdown-to-word.ts`

- [ ] **步骤 1：实现页面状态与文件读取**

页面需要包含：
- 上传 `.md` 文件区域
- Markdown 文本域
- 右侧实时预览
- 下载按钮
- 文件大小/字数提示
- 错误提示

- [ ] **步骤 2：实现下载逻辑**

下载按钮调用：

```ts
const blob = await createMarkdownDocxBlob(markdown, filename)
const url = window.URL.createObjectURL(blob)
const link = document.createElement('a')
link.href = url
link.download = filename
link.click()
window.URL.revokeObjectURL(url)
```

- [ ] **步骤 3：页面视觉布局**

使用现有 `Card`、`Button`、`Textarea`、`Input`、`ScrollArea` 组件，保持项目 light-mode-first 的 B2B SaaS 风格。

- [ ] **步骤 4：静态验证页面**

```bash
cd frontend && pnpm lint
```

预期：无错误、无未使用变量。

---

### 任务 3：接入特殊功能菜单与页面标题

**文件：**
- 修改：`frontend/lib/sidebar-config.ts`
- 修改：`frontend/lib/dashboard-route-meta.ts`

- [ ] **步骤 1：新增菜单项**

在 `special` 分组 `items` 中新增：

```ts
{ title: 'Markdown 转 Word', url: '/dashboard/special/markdown-to-word', icon: IconMap.FileText },
```

- [ ] **步骤 2：扩展 icon 映射**

在 `IconMap` 中加入：

```ts
FileText,
```

- [ ] **步骤 3：新增标题映射**

在 `DASHBOARD_PAGE_TITLES` 中加入：

```ts
{ match: '/special/markdown-to-word', title: 'Markdown 转 Word' },
```

- [ ] **步骤 4：静态验证导航配置**

```bash
cd frontend && pnpm lint
```

预期：无错误。

---

### 任务 4：完整前端验证

**文件：**
- 无

- [ ] **步骤 1：运行前端 lint**

```bash
cd frontend && pnpm lint
```

预期：0 errors。

- [ ] **步骤 2：运行前端生产构建**

```bash
cd frontend && pnpm build
```

预期：exit 0，无构建错误。

- [ ] **步骤 3：业务测试清单**

完成后向用户输出业务测试清单：
1. 打开 `/dashboard/special/markdown-to-word`
2. 确认左侧上方可上传 `.md` 文件并自动填入内容
3. 确认左侧下方可直接粘贴/编辑 Markdown
4. 确认右侧实时预览随内容变化
5. 确认空内容时下载按钮不可用或提示无法生成
6. 点击下载按钮，确认生成 `.docx` 文件且文件名正确
