# ad_analysis — 广告分析工具集（v2.2）

> 配套文档：`../docs/ad-analysis-framework.md`
> 主权威：v2.2 框架文档（§3 阈值 / §5 词性 / §6 单位价值 / §9 D1-D5）

## 模块清单

| 文件 | 职责 |
|------|------|
| `load_data.py` | 从 `dash-api.believeboy.com` 拉取所有广告端点 → 本地 JSON 缓存 |
| `classify.py` | 词性分类器（8 类无词典版）+ 项目 taxonomy 加载 |
| `metrics.py` | 置信度标签、单位价值、share_max 聚合等通用指标 |
| `d1_signals.py` | D1 高 ROAS × 低曝光词 |
| `d2_associate.py` | D2 互补品反哺（purchased-products） |
| `d3_terms.py` | D3 词性 + matchType 矩阵 |
| `d4_targets.py` | D4 提价机会（TopShare） |
| `d5_burst.py` | D5 爆发词识别（14d vs 14d） |
| `run.py` | CLI 主入口，一键跑主题 D 全部子主题 |

## 快速开始

### 1. 一键跑主题 D（推荐）

```bash
cd believeboySP/scripts
python -m ad_analysis.run --project 4 --country US
```

输出：
- 控制台：每个 D 子主题的 Top N 强信号 + 简表
- 文件：`/tmp/ad-analysis/{project_id}/report.md`（Markdown 报告）

### 2. 单独跑某个子主题

```bash
# D1 强信号
python -m ad_analysis.d1_signals --project 4

# D5 爆发词（自动拉 14d vs 14d）
python -m ad_analysis.d5_burst --project 4
```

### 3. 编程式调用

```python
from ad_analysis import load_data, classify, metrics
from ad_analysis.d1_signals import find_d1_strong

# 1. 拉数据
data = load_data.fetch_all(project_id=4, country="US", period="30d")

# 2. 词性分类
terms = [r["search_term"] for r in data["search_terms"]["data"] if r.get("search_term")]
types = [classify.classify(t) for t in terms]

# 3. 找 D1 强信号
strong = find_d1_strong(data["search_terms"]["data"], data["search_term_shares"]["data"])
for s in strong[:10]:
    print(f"{s['term']} | ROAS={s['roas']} | Share={s['imp_share']}% | conf={s['confidence']}")
```

## 配置文件

- `../../project-configs/4-yuehan.yaml` — 主配置（4 档阈值 + 行业基准）
- `../../project-configs/4-yuehan-taxonomy.yaml` — 词性词典 + 互补品候选

加载方式：`config = load_data.load_config(project_id=4)`

## 主题 D 实战指标（v2.2 验证版）

| 强信号 | 玥涵 30d 实测 |
|--------|---------------|
| D1 高 ROAS × 低曝光词 | 7 命中（去噪后）|
| D2 互补品反哺 | 4 候选 ASIN（$391 关联销售）|
| D3 词性主力 | attribute_modifier（165 词 / 57 单 / ROAS 3.76）|
| D4 提价机会 | 9 目标（TopShare<5% + ROAS≥3）|
| D5 真爆发 | 1 个（`m35 cobalt drill bit set` ROAS 8.67）|

## 数据流

```
API (dash-api.believeboy.com)
  │
  ├─ load_data.fetch_all()
  │    ↓
  │    /tmp/ad-analysis/{project_id}/{endpoint}.json  (本地缓存)
  │
  └─ 各 D 子主题脚本读取 JSON → 计算强信号 → 输出
       ↓
       控制台表格 + Markdown 报告
```