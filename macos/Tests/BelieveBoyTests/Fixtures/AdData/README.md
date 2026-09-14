# 广告数据快照（BLF-1057）

11 个 `GET /api/v1/internal/ad-data/*` 端点的**真实后端响应**，用于把「与 Web 同源同值」变成
可执行断言（`AdDataDecodingTests` / `AdDataFormattingTests` / `AdDataClientTests` /
`AdDataRenderingTests`）。

## 为什么是真实响应

后端这 10 个原始行端点在 Pydantic 侧是 `list[dict[str, object]]`（每行 12–22 个业务字段 + 一整列
**中文** `raw_row`）。手写一份「看起来对」的 JSON 只能证明解码器能解自己编的数据；而键名写错在
Swift 侧**不会编译报错、不会解码失败**（取值为 nil → 该列整列显示占位），只会静默少一列数据。
所以夹具必须是后端真正吐出来的东西，并且逐类型断言「每个列键都能在每一行取到值」。

## 抓取口径（`manifest.json` 里也逐项记着）

- 后端：本地后端 + 生产快照库 `BLF`（`backend/.env` 的 `DATABASE_URL`），经 FastAPI
  `TestClient` 走真实 HTTP 路由（不是直接调 service 函数）。
- 鉴权：`X-API-Key`（主 key）+ `X-Is-Admin: true`。
- 固定参数：`project_id=1`、`country=US`、`period=custom` +
  **哨兵窗口** `start_date=2000-01-01` / `end_date=2100-12-31`。
  与 S5.1 广告分析页同一组固定参数，便于两批互相对照。
- 抓取时点：见 `manifest.json` 的 `captured_at`；逐文件 `sha256` / `bytes` / 行数同在 manifest。

### 为什么日期是哨兵窗口而不是「不传」

`period` 在这个通道上是**必填**的：不传会被 `400 {"detail":"period is required"}` 拒（`period=custom`
又要求两个日期都给）。Web 的写法就是哨兵窗口（`ad-data-explorer.tsx` 的
`start_date: dateFrom || '2000-01-01'`），桌面端逐字照搬 —— 所以夹具也必须用同一组参数才谈得上
「同源同值」。

### 为什么落盘用 `limit=200`（页面口径是 10000）

页面口径是单发 `limit=10000`，但 10 个端点合起来 **22.5 MB**（实测最大
`ad-promoted-products-raw` 单份 9.9 MB / 7805 行）。把 22 MB 真实响应塞进 git 历史的代价远大于
收益，而**解析器要钉的东西与行数无关**（信封键名 / 逐类型列键 / `raw_row` 中文列 / 值类型）。

因此夹具取 **200 行切片**，同时在 manifest 里记下 `limit=10000` 的**真实**行数与字节数
（`full_rows` / `full_bytes`，只测量不落盘）：
`testPageLimitIsNotReachedByAnyReportType` 用它们复核「10 个类型都不到 10000 行、今天不截断」
这条结论。

两个端点的全量数据本来就不足 200 行（`time-trends` 98 行、`purchased-products` 15 行），
所以夹具同时覆盖了「顶到 limit（可能截断）」与「完整数据」两种判据。

### 复核过的两件事（BLF-1057 抓取时实测）

1. **切片里的行与 `limit=10000` 响应里的同一 id 行逐字段一致**（10/10 端点，0 处不一致）
   —— 夹具里的数值就是 Web 在同一组参数下看到的数值。
2. 同一组参数、同一个端点，`limit=200` 的窗口并**不总是** `limit=10000` 响应的前缀
   （8 条端点不是、2 条是）：`_run_raw_query` 只按 `report_end_date` 排序、没有 tiebreaker，
   同日期的行之间次序不稳定。这正好印证口径 2「不做服务端 offset 翻页」的判断。

## 重新抓取

```bash
python3 macos/scripts/capture-ad-data-fixtures.py                 # 写回本目录
python3 macos/scripts/capture-ad-data-fixtures.py --out <dir>     # 写别处（复核漂移用）
```

脚本随本批提交（`macos/scripts/capture-ad-data-fixtures.py`）：`TestClient` + 上面那组
header/参数，只发 GET，无写请求。重抓后**必须**同时更新 `manifest.json` 的
`sha256` / `bytes` / 行数 / `captured_at`，并在 PR 里写明新的哈希 —— 快照不许悄悄换：
`AdDataDecodingTests.testCommittedSnapshotHashesMatchManifest` 会拦下不一致的提交。

## 目录

| 文件 | 说明 |
| --- | --- |
| `manifest.json` | 抓取元数据 + 逐文件 `sha256` / 字节数 / 行数 + 页面口径下的真实行数与体积 |
| `ad-data-<endpoint>-raw.json` | 10 个原始行端点各一份（`limit=200` 切片，哨兵窗口） |
| `ad-upload-files.json` | 入库文件列表（`limit=500` = 端点上限）：**截断**的列表，用于口径 3 |

`ad-upload-files.json` 里**没有** `ad_search_term_report`，而 `ad-data-search-terms-raw.json` 有
200 行（全量窗口 1321 行）—— 这就是口径 3 的证据：照抄 Web 拿这份列表给报表类型置灰，会把
「搜索词」这类久未入库的类型误判成「暂无数据」。
