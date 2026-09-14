# 广告分析快照（BLF-1056）

10 个 `GET /api/v1/ad-analysis/*` 端点的**真实后端响应**，用于把「与 Web 同源同值」变成
可执行断言（`AdAnalysisDecodingTests` / `AdAnalysisFormattingTests` / `AdAnalysisClientTests`）。

## 为什么是真实响应

后端这 10 个端点在 Pydantic 侧一律声明成 `list[dict[str, object]]`
（`backend/app/schemas/ad_analysis.py`）——**契约层面就没有逐字段的名字与类型**。
手写一份「看起来对」的 JSON 只能证明解码器能解自己编的数据；而键名写错在 Swift 侧
不会编译报错、不会解码失败（可选字段一律 nil），只会静默少一列数据。所以夹具必须是
后端真正吐出来的东西，并且逐 Tab 断言「每个列键都能取到值」。

## 抓取口径（`manifest.json` 里也记着）

- 后端：本地后端 + 生产快照库 `BLF`（`backend/.env` 的 `DATABASE_URL`），
  经 FastAPI `TestClient` 走真实路由（不是直接调 `build_*` 函数）。
- 鉴权：`X-API-Key`（主 key）+ `X-Is-Admin: true`。
- 固定参数：`project_id=1`、`country=US`。
- 两个集合：
  - `full-history`：**不传** `date_from` / `date_to`（口径 1：不传日期 = 全量历史），10 个 Tab 各一份；
  - `windowed`：`date_from=2026-08-01`、`date_to=2026-09-12`，只留 `overview` / `time-trend`
    ——用于覆盖 `comparison` 非 null 的分支（不传日期时后端返回 `null`）。另外 8 个 Tab
    的窗口化响应与全量响应**形状完全相同**，附上只是重复占体积。

## 重新抓取（后续批次复核同一形状是否漂移时）

```bash
cd backend
../scratch/capture_ad_analysis.py --out ../macos/Tests/BelieveBoyTests/Fixtures/AdAnalysis   # 全量
../scratch/capture_ad_analysis.py --out <dir> --date-from 2026-08-01 --date-to 2026-09-12 --suffix=-windowed
```

用到的脚本（`TestClient` + 上面那组 header/参数，只发 GET）不随本批提交；重抓时按本节
口径重建即可。重抓后**必须**同时更新 `manifest.json` 的 `bytes` / `sha256` /
`counts` 与 `captured_at`，并在 PR 里写明新的哈希 —— 快照不许悄悄换：
`AdAnalysisDecodingTests.testCommittedSnapshotHashesMatchManifest` 会拦下不一致的提交。

## 目录

| 文件 | 说明 |
| --- | --- |
| `manifest.json` | 抓取元数据 + 逐文件 `sha256` / 字节数 / 各字段行数 |
| `ad-analysis-<tab>.json` | 全量历史（不传日期）的 10 个 Tab |
| `ad-analysis-<tab>-windowed.json` | 带日期区间的 `overview` / `time-trend` |
