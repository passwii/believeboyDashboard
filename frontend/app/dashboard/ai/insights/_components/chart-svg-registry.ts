/**
 * PNG 导出用图表 SVG 注册表（BLF-1017 从旧洞察页原样抽出）。
 *
 * 导出流程分两帧：第一帧让 ChartCodeBlock 把图表渲染成自包含 SVG data URL 写进这里，
 * 第二帧 html-to-image 才能稳定截到图。写入方是 ChartCodeBlock，读取方是页面导出逻辑。
 */
export const chartSvgRegistry = new Map<string, string>()
