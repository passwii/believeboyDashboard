# 广告分析框架 v2.2 — 增长导向

> **版本**: v2.2（2026-07-02 实践反哺版）
> **主权威**: 本文件
> **测试项目**: 玥涵 PROJECT (id=4, US, 30d, 2026-06-02 ~ 2026-07-01)
> **API 文档**: `BLF-广告Agent API 实践指南.md`

## 0. 变更日志

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-07-02 | 初版：6 维度框架 + 跨维度组合 A-F |
| v2.0 | 2026-07-02 | 引入"时间窗口体系"+"动态评价标准" |
| v2.1 | 2026-07-02 | 7 个开放问题收敛：店铺阶段/基准文件/样本过滤/连续 4 周期/否定词/关联销售/跨项目 |
| **v2.2** | **2026-07-02** | **主题 D 实践反哺：impression_share 聚合 S1 max / 置信度标签 / 词性分类器 / 单位价值指标 / D3×matchType 矩阵** |

## 1. 顶层设计原则

| # | 原则 | 含义 |
|---|------|------|
| P1 | 数据驱动 | 任何结论必须有数字依据 + 上下文（时间窗口 + 评价标准） |
| P2 | 指标分桶 | 任何指标归到"优秀 / 良好 / 一般 / 不及格"四档 |
| P3 | 多窗口交叉 | 7d/14d/30d/90d 必须同时看，单一窗口会骗人 |
| P4 | 维度可下钻 | 任何"活动层"结论必须能下钻到"搜索词/目标/产品/位置"找根因 |

## 2. 时间窗口体系

| 窗口 | 逻辑 | 用途 | 注意点 |
|------|------|------|--------|
| **7d** | 亚马逊归因窗口 = 7d，最小有意义单元 | 紧急诊断 / 止损 | 实质覆盖 5-6 完整数据日（24-48h 延迟） |
| **14d** | 2 个完整周，消"周内节律" | 周环比 | 7d 的 2 倍 |
| **28d** | 严格 4 周整，剔除不齐 | 月环比 | **对比场景首选** |
| **30d** | 行业默认 | 日常汇报 | 与日历月不对齐 |
| **90d** | 4 个 30d 滚动 | 长期趋势 | 剔除一次性事件 |
| **ytd** | 年度累计 | 战略层对比 | |
| **this_month/last_month** | 自然月对齐 | 财务汇报 | this_month 需标注"截至 D 日" |

**周期对比矩阵**：

| 窗口 | 诊断强度 | 数据稳定性 | 趋势灵敏度 | 决策速度 |
|------|---------|-----------|-----------|---------|
| 7d   | ★★★★★ | ★★        | ★★★★★    | 实时 |
| 14d  | ★★★★  | ★★★       | ★★★★     | 周会 |
| 28d  | ★★★   | ★★★★      | ★★★      | 月会 |
| 30d  | ★★    | ★★★★      | ★★       | 月报 |
| 90d  | ★     | ★★★★★     | ★        | 季报 |

**基准线频率（v2.1 决策）**：连续 **4 个周期**对比（T / T-1 / T-2 / T-3 四个 14d 窗口），不只看环比上一周期。

**红旗规则**：
- 7d 骤变 (>±30%) → 14d / 30d 同步检查
- 30d 走好但 7d 走平 → 见顶信号
- 30d 走差但 7d 反弹 → 短期止血可能掩盖结构问题
- 节日/大促前后 → 周期对比要"剥离节日周"

## 3. 动态评价标准体系（v2.0 引入，v2.1 收敛）

### 3.1 阈值的"双锚定"原则

```
最终阈值 = ƒ(项目内分位锚, 活动分组, 店铺阶段, 绝对参考线)
```

**四个锚**：
- **A 项目分位锚**：项目内同维度中位数（不用平均数）
- **B 活动分组锚**：按 campaign_type / targeting_type / match_type 分组
- **C 生命周期锚**：店铺阶段（new / growth / mature / declining）
- **D 绝对参考线**：亚马逊品类基准 / 行业经验值

### 3.2 核心指标四档阈值模板

| 指标 | 优秀 | 良好 | 一般 | 不及格 | D_绝对参考 |
|------|------|------|------|--------|-----------|
| ACOS | ≤ A×0.5 | ≤ A | ≤ A×1.5 | > A×1.5 | Amazon SP 25-35% |
| ROAS | ≥ 1/ACOS_良好 × 1.5 | ≥ 1/ACOS_良好 | ≥ 1/ACOS_一般 | < 1/ACOS_一般 | ROAS > 3 健康 |
| CTR | > A×1.5 | > A | > A×0.7 | ≤ A×0.7 | 0.3-0.5% |
| CVR | > A×1.5 | > A | > A×0.5 | ≤ A×0.5 | 10-15% |
| CPC | < A×0.7 | < A | < A×1.3 | ≥ A×1.3 | 品类波动大 |
| 无效曝光率 | < 5% | < 10% | < 20% | ≥ 20% | 行业经验 |
| 预算利用率 | 80-100% | 60-80% 或 100%+ | 40-60% | < 40% | >100% 被卡 |

### 3.3 置信度标签（**v2.2 新增**，反哺 8）

```
★high   : impressions ≥ 100, orders ≥ 3
☆medium : impressions ≥ 20, orders ≥ 1
.low     : orders = 1
..none   : orders = 0
```

**应用规则**：
- `★high` / `☆medium` → 进入"立即行动" / "本周行动" 清单
- `.low` → 只能进"观察池"，不进立即行动
- `..none` → 进入"否定词候选"或"高 spend 警告"

### 3.4 应用规则

1. **同分位对比优先**：同 match_type 内比 exact vs phrase
2. **样本量过滤**：曝光 < 100 或点击 < 10 的指标**不进入阈值判断**（默认品类大词规则）
3. **趋势优先单点**：单期"良好"但"持续下滑"应判为"需关注"
4. **金额加权 vs 数量加权**：高 spend 的活动优先评估
5. **店铺阶段豁免**：新店前 30 天可放宽一档

## 4. 项目级配置（v2.1 引入）

**文件路径**：`project-configs/{id}-{slug}.yaml`

```yaml
project:
  id: 4
  name: 玥涵
  stage: growth           # 枚举: new | growth | mature | declining
  primary_country: US
  category: drill_bits    # 用于跨项目对比的品类标签
  peer_project_ids: []    # 用户手动指定的对照项目

thresholds:
  acos:    { excellent: 15.0, good: 25.0, fair: 40.0 }
  roas:    { excellent: 6.67, good: 4.0,  fair: 2.5 }
  ctr:     { excellent: 1.0,  good: 0.5,  fair: 0.3 }
  cvr:     { excellent: 15.0, good: 10.0, fair: 5.0 }
  invalid_impression_rate: { excellent: 5.0, good: 10.0, fair: 20.0 }

industry_baseline:        # 兜底，手动维护
  acos_avg_sp: 30.0
  ctr_avg_sp: 0.4
  cvr_avg_sp: 10.0

sampling:
  head_term:   { min_impressions: 100, min_clicks: 10, confidence: high }
  long_tail:   { min_impressions: 0,   min_clicks: 0,  confidence: low }

time_windows:
  default: 30d
  trend: 90d
  comparison_periods: 4   # 连续 4 周期对比
```

## 5. 词性分类器（**v2.2 新增**，反哺 7）

### 5.1 无词典版（默认）

```python
ATTR_KW = {"cobalt","m35","hss","metric","fractional","titanium","carbide","hex","shank",
           "tapered","step","twist","center","spot","index","jobber","auger","forstner",
           "point","split","large","small","mini","long","short","thick","thin","heavy",
           "black","gold","silver","diamond","oxide"}
SCENE_KW = {"metal","steel","stainless","aluminum","wood","masonry","concrete","plastic",
            "hardened","iron","brass","copper","alloy"}
BRAND_KW = {"dewalt","milwaukee","bosch","makita","ryobi","irwin","hilti","klein",
            "drill hog","neiko","snadico","kreg","titan","workpro","craftsman"}
COMP_KW = {" vs "," review"," best "," top "," cheap"," quality"," professional"," pro "}

def classify(term):
    if not term: return "unknown"
    t = term.lower().strip()
    p = f" {t} "
    n = len(t.split())
    if re.match(r"^b0[a-z0-9]{8}$", t): return "asin"
    if re.match(r"^\d{3,}$", t): return "numeric_id"
    if re.match(r'^\d+[\"\'\u201d\u2019/]', t) or re.match(r"^\d+\s*(inch|mm|cm|in)\b", t): return "spec_size"
    if any(kw in p for kw in COMP_KW) or any(t.startswith(kw.strip()) for kw in ["best","top"]): return "comparison"
    if any(b in p for b in BRAND_KW): return "competitor_brand"
    if any(k in p for k in ATTR_KW): return "attribute_modifier"
    if any(k in p for k in SCENE_KW): return "scene_specific"
    if n <= 2: return "category_core"
    if n >= 3: return "long_tail"
    return "other"
```

### 5.2 项目词典化（**v2.2 规划**，反哺 7 落地）

**文件**：`project-configs/{id}-taxonomy.yaml`

```yaml
brand_self:    [believeboy]                 # 自有品牌
competitors:   [dewalt, milwaukee, bosch, makita, ryobi, irwin, hilti, klein, drill hog, neiko, snadico, kreg, titan, workpro, craftsman]
sku_prefixes:  [tws, rsd, jdb, m35, ...]     # 自家 SKU 前缀
material_synonyms:
  cobalt: [cobolt, coblat, cobolt]
  metric: [metrical, metrik]
```

**新结构**：`classify(term, taxonomy) → type`

## 6. 单位价值指标（**v2.2 新增**，反哺 6）

```
单位价值 = ROAS × 订单 / 词数
```

**应用**：
- 高单位价值 + 大词数 = 扩量目标
- 低单位价值 + 大词数 = 砍预算候选
- 高单位价值 + 小词数 = 谨慎观察（样本不足）
- 低单位价值 + 小词数 = 忽略

**典型排序（玥涵实测 30d）**：
1. `category_core`：1.78（10 词 / 6 单 / ROAS 2.97）— 单位价值高但天花板低
2. `attribute_modifier`：1.30（165 词 / 57 单 / ROAS 3.76）— **最优扩量**
3. `long_tail`：0.87（79 词 / 24 单 / ROAS 2.86）
4. `scene_specific`：0.61（44 词 / 9 单 / ROAS 2.96）
5. `competitor_brand`：0.30（样本不足）
6. `asin`：0.08（**砍**）
7. `spec_size`：0.03（**砍**）
8. `comparison`：0.00（**立即停**）

## 7. 6 大维度（v1.0 + 实践增强）

### 维度 1｜活动健康度（流量视角加强）

**新增/加强点**：
- 流量结构（top-of-search / product-pages / rest）— `ad-placements`
- 流量质量（无效曝光率）— `ad-invalid-traffic`
- 流量竞争（impression_share、top_of_search_impression_share）— `ad-targets`
- 流量成本（CPM = spend/impressions × 1000）
- 多窗口验证：7d 异常 + 30d 稳定 + 90d 趋势

### 维度 2｜搜索词精细化（最高优先级）

**新增/加强点**（v2.2）：
- **词性分类**（8 类，§5）
- **置信度标签**（§3.3）
- **单位价值**（§6）
- 词频分布 / 词性分类 / 长尾度 / 购买阶段
- 同义词合并 / 否定词候选多档阈值
- **D5 三指标**：绝对新词率 / 轮换率 / 爆发词（v2.2 反哺 10）

### 维度 3｜目标/定位粒度

**新增/加强点**：
- 目标类型分层（category= / asin= / brand=）
- impression_rank × ROAS 矩阵
- **TopShare < 5%（成熟店更严）**（v2.2 反哺 5）
- 同目标多 match_type 效率差

### 维度 4｜产品/ASIN 维度

**新增/加强点**：
- scope_status 分层后的 ACOS 差异
- halo effect 量化（ad_sku 销售 / other_sku 销售）
- ASIN-level ACOS（与 orders JOIN）
- 关联销售路径的"链路 ROAS"

### 维度 5｜位置、时间、流量质量

**新增/加强点**：
- 位置 × bidding_strategy 组合效率
- 时间序列异常检测（7d 滚动 vs 30d 滚动）
- 周内节律
- **CPM** 作为位置效率统一指标

### 维度 6｜订单侧归因与漏斗

**新增/加强点**：
- 广告归因订单 vs 真实订单的"贡献度时间序列"
- AOV 对比的金额加权 vs 数量加权
- 退款订单（is_counted_sales=false）对 ACOS 反向修正
- 广告单 vs 自然单的"质量对比"

## 8. 跨维度组合（v1.0 + 拓展）

按"决策主题"重组：

| 主题 | 端点组合 | 核心问题 | 行动 |
|------|---------|---------|------|
| **A 降本** | 6 组合（A1-A6）| 找高 spend 低回报 | 暂停 / 否定 / 调整出价 |
| **B 提效** | 6 组合（B1-B6）| 找高 ROAS 低投入 | 加预算 / 提价 / 跨 SKU 组合 |
| **C 风险预警** | 6 组合（C1-C6）| 找异常 | 立即诊断 / 查 listing |
| **D 增长（本次实践主题）**| 6 组合（D1-D6）| 找扩量机会 | 加预算 / 加词 / 提价 |
| **E 结构性优化** | 6 组合（E1-E6）| 找架构问题 | 合并 / 重组 / 砍 |
| **F 协同效应** | 8 组合（F1-F8）| 找链路断点 | JOIN 多端点 |

## 9. 主题 D 实践记录（v2.2 新增）

**测试项目**：玥涵 id=4 / US / 30d（2026-06-02 ~ 2026-07-01）

### 9.1 D1 | 高 ROAS × 低曝光词

**筛选**：ROAS≥2 + orders>0 → 48 命中
**强信号**：ROAS≥3 + ImpShare<30% + conf≥medium → **7 命中**（置信度过滤前为 15）

**强信号清单**（v2.2 重算后）：

| Conf | 词性 | 搜索词 | ROAS | Share | Sales | Orders |
|------|------|--------|------|-------|-------|--------|
| ★high | attribute_modifier | drill index | 7.72 | 29.5% | $147.96 | 3 |
| ★high | scene_specific | metal drill bit set for steel | 6.25 | 9.6% | $118.77 | 3 |
| ☆medium | attribute_modifier | metric drill bit set | 17.03 | 5.6% | $91.98 | 2 |
| ☆medium | competitor_brand | drill hog drill bits | 20.75 | 20.5% | $123.45 | 1 |
| ☆medium | attribute_modifier | drill bit index | 4.87 | 20.5% | $36.99 | 1 |
| ☆medium | long_tail | drill bit sets | 3.37 | 2.3% | $36.99 | 1 |
| ☆medium | category_core | drill bit | 3.33 | 0.6% | $10.99 | 1 |

### 9.2 D2 | 互补品策略

- 30d 内互补品词仅 4 个（全是 ASIN 形式）
- 总 spend $2.77 / 总 sales $0 / 0 订单 → **完全失败**
- 触发活动：A-黑金29pcs-1, 0.02捡漏
- **建议**：先用 `ad-purchased-products` 找成功关联 ASIN 反哺互补品候选；当前缩量

### 9.3 D3 | 词性分析

**30d 搜索词 391 个分 8 类**（按花费排序）：

| 类型 | 词数 | 词数% | 曝光% | 花费% | 销售% | 订单 | ROAS | 单位价值 |
|------|------|-------|-------|-------|-------|------|------|----------|
| **attribute_modifier** | 165 | 42.2% | 54.8% | 53.6% | 60.8% | 57 | **3.76** | **1.30** |
| long_tail | 79 | 20.2% | 31.5% | 23.3% | 20.0% | 24 | 2.86 | 0.87 |
| scene_specific | 44 | 11.3% | 6.0% | 9.8% | 8.8% | 9 | 2.96 | 0.61 |
| asin | 47 | 12.0% | 0.4% | 1.9% | 1.1% | 2 | 1.96 | 0.08 |
| spec_size | 30 | 7.7% | 1.4% | 3.0% | 0.9% | 1 | 1.02 | 0.03 |
| competitor_brand | 14 | 3.6% | 0.2% | 2.2% | 2.8% | 1 | 4.19 | 0.30 |
| category_core | 10 | 2.6% | 5.7% | 5.9% | 5.3% | 6 | 2.97 | 1.78 |
| comparison | 2 | 0.5% | 0.0% | 0.2% | 0.0% | 0 | 0.00 | 0.00 |

**核心洞察**：
- `attribute_modifier` 是**主战场**（165 词 / 60% 销售 / ROAS 3.76）
- `category_core` 单位价值最高 1.78，但词数仅 10，**扩量天花板低**
- `asin` 47 词换来 2 单 → **应砍**
- `comparison` 0 转化 → **应立即停**
- `spec_size` ROAS 1.02 → **应缩量**

### 9.4 D3 × matchType 矩阵（v2.2 反哺 9 落地）

**属性词（attribute_modifier）× matchType / targetingType**：

| matchType | targetingType | 词数 | 曝光 | 花费 | 销售 | 订单 | CTR% | CVR% | ROAS |
|-----------|---------------|------|------|------|------|------|------|------|------|
| EXACT | exact | 6 | 17933 | $241.64 | $905.77 | 19 | 0.91 | 11.59 | 3.75 |
| - | close-match | 110 | 17095 | $399.07 | $1387.66 | 31 | 1.70 | 10.69 | 3.48 |
| - | **loose-match** | **55** | **1128** | **$61.22** | **$352.53** | **7** | **5.50** | **11.29** | **5.76** |
| - | substitutes | 1 | 1 | $0.90 | $0 | 0 | 100 | 0 | 0.00 |

**长尾词（long_tail）× targetingType**：

| targetingType | 词数 | 花费 | 销售 | 订单 | ROAS |
|---------------|------|------|------|------|------|
| close-match | 58 | $277.41 | $858.97 | 23 | 3.10 |
| loose-match | 19 | $25.80 | $0.00 | 0 | **0.00** |

**关键洞察**：
- **属性词 × loose-match ROAS 5.76 最高**（55 词 / 7 单 / CTR 5.50% / CVR 11.29%）— **最优扩量组合**
- 长尾词 × loose-match **完全失败**（19 词 / 0 订单）— 漏斗配置问题
- EXACT 手动活动是转化主力（CVR 11.59%）

### 9.5 D4 | 目标提价机会

**强信号（ROAS≥3 + TopShare<5% + conf≥medium，9 命中）**：

| Conf | Campaign | AdGroup | Target | ROAS | TopShare | Sales | Orders |
|------|----------|---------|--------|------|----------|-------|--------|
| ★high | A-黑金29pcs-1 | A-黑金29pcs | close-match | 3.24 | 0.12% | $671.68 | 16 |
| ★high | A-Close-CS29-Max | CS29 | close-match | 3.30 | 0.00% | $593.89 | 11 |
| ★high | A-黑金29pcs-1 | A-黑金29pcs | loose-match | 4.86 | 0.57% | $196.57 | 3 |
| ★high | 0.02捡漏 | 0.02捡漏 | substitutes | 4.24 | 0.00% | $38.97 | 3 |
| ☆medium | 10 | 等柄钻 | loose-match | 6.32 | 0.03% | $63.98 | 2 |
| ☆medium | 捡漏 | 捡漏 | loose-match | 8.41 | 0.07% | $36.99 | 1 |
| ☆medium | A-115pcs-2 | Cm115 | loose-match | 3.81 | 0.00% | $253.44 | 2 |
| ☆medium | 捡漏 | 捡漏 | substitutes | 5.60 | 0.00% | $36.99 | 1 |
| ☆medium | A-M35-29pcs-2 | M35-29pcs-2 | close-match | 4.43 | 0.28% | $54.99 | 1 |

### 9.6 D5 | 新词识别（**v2.2 重定义 + 落地**，反哺 10）

**D5 三指标**：

| 指标 | 玥涵 30d 实测 | 解读 |
|------|--------------|------|
| **绝对新词率**（30d 出现且 90d 未出现）| 0% | 成熟店特征 |
| **轮换率**（近 14d 新词 / 上 14d 总词）| 155/210 = **74%** | 流量活跃 |
| **爆发词**（同词近 14d 出现频次 > 前 14d × 1.5）| **15 命中 / 1 真爆发** | 见下表 |

**爆发词筛选逻辑（**v2.2 落地版**）**：

```
P1: recent_impr > prev_impr × 1.5  AND  prev_impr > 0    # 频次爆发
P2: recent_orders > prev_orders                          # 订单爆发
P3: recent_sales > prev_sales × 2                        # 销售爆发
触发条件: P1 OR (P2 AND P3)
```

**D5 实战结果（v2.2 落地）**：

| 类别 | 词数 | 解读 |
|------|------|------|
| P1 频次爆发 | 14 | 大多 0 销售 → 噪声 |
| **P2+P3 成交爆发** | **1** | **真信号** |
| 绝对新词 | 0 | 成熟店 |

**唯一真爆发**：

| 搜索词 | 上 14d | 近 14d | 增长 | 销售增长 | ROAS |
|--------|--------|--------|------|----------|------|
| `m35 cobalt drill bit set` | 1 单 / $54.99 | **3 单 / $202.97** | +2 单 / +$147.98 | **×3.69** | **8.67** |

**D5 行动建议**：
- 立即加预算 `m35 cobalt drill bit set` 词到 P1 强信号清单
- 14 个 P1 频次爆发但 0 销售的词 → 进"观察池"，等 7-14d 后复测
- D5 不应只看"绝对新词率"，**真信号是 P2+P3 成交爆发**

### 9.7 D2 | 互补品反哺（v2.2 落地）

**核心问题**：原 D2 显示 4 个 ASIN 互补品 0 销售 → 失败。需要"反哺"——从已成功的关联销售找候选 ASIN。

**数据源**：`ad-purchased-products` 90d（6 行）

**反哺逻辑**：广告 SKU A → 用户实际购买 SKU B → B 是 A 的"互补品候选"

**关联销售 Top 5**：

| Ad SKU | Ad ASIN | Purchased ASIN | 关联单 | 关联销售 | 触发活动 |
|--------|---------|----------------|--------|----------|---------|
| TWS-CF29SET | B0DBH5QF5P | **B0DBH6Z3D4** | 3 | **$164.97** | A-黑金29pcs-1 |
| TWS-CF29SET | B0DBH5QF5P | **B0DBH66YJP** | 1 | **$129.99** | A-黑金29pcs-1 |
| TWS-CS13SET | B0DHC23P4C | B0DNJT7YD3 | 2 | $44.97 | 13pcs自动 |
| TWS-CF15SET | B0DNJT7YD3 | B0DBH5L7BK | 2 | $38.97 | 同尺寸紧密 |
| TWS-CS13SET | B0DHC23P4C | B0DBH5L7BK | 1 | $12.99 | 13pcs自动 |

**总关联销售 $391.89 / 9 订单**（即"光环效应"销售）

**D2 行动建议**：
- **小预算测试** Top 3 候选 ASIN（B0DBH6Z3D4, B0DBH66YJP, B0DNJT7YD3）
- 注意 `TWS-CF29SET` 推 → 用户买 `B0DBH6Z3D4` 关联强度最高（$164.97/3单）— 优先测试
- 已写入 `project-configs/4-yuehan-taxonomy.yaml` `complementary_asins` 段

## 10. v2.2 反哺点清单（11 个）

| # | 反哺 | 来源 | 落地 |
|---|------|------|------|
| 1 | D5 重新定义为三指标（绝对/轮换/爆发）| D5 实测 0 信号 | §9.6 |
| 2 | impression_share 聚合：S1 max 主用 | D1 重算发现累加 | §3.3 + §9.1 |
| 3 | 长尾词置信度低 → 置信度标签 | D1 Top 70% 是 1 单 | §3.3 + §9.1 |
| 4 | 项目级 baseline 自动校准 | 阈值经验值缺校准 | §3.1（公式） |
| 5 | D4 TopShare < 5%（成熟店更严）| 33 目标全 <30% | §9.5 |
| 6 | 扩量优先级矩阵（单位价值）| D3 多 type 比较 | §6 |
| 7 | 词性分类器 + 项目词典化 | 缺品牌词识别 | §5 |
| 8 | 置信度标签（★/☆/.）| 长尾词 ROAS 不可靠 | §3.3 |
| 9 | 词性 × matchType 矩阵 | D3 + targets JOIN | §9.4 |
| 10 | D5 三指标 | 成熟店 D5 失效 | §9.6 |
| 11 | 分析重心从 targeting_type 转到 match_type | targeting_type 不可配置 | §9.4 注释 |

## 11. 主题 D 完整行动清单（v2.2 实践产出）

### 立即执行（24-48h）

| # | 行动 | 来源 | 量化 |
|---|------|------|------|
| A1 | 暂停 comparison 词（2 词）| D3 | 释放 $2.85 |
| A2 | 大幅缩量 asin 词（47 → 留 Top 5）| D3 | 释放 ~$20 |
| A3 | 缩量 spec_size 词（30 → 留 Top 5）| D3 | 释放 ~$30 |
| A4 | 暂停 `固定0.2捡漏`（无效曝光 34.25%）| 实测 | 释放无效流量 |

### 本周执行

| # | 行动 | 来源 | 量化 |
|---|------|------|------|
| B1 | 提价 `A-黑金29pcs-1` close-match 目标 | D4 ★high | TopShare 0.12% / 16 单 / $671 |
| B2 | 提价 `A-Close-CS29-Max` close-match 目标 | D4 ★high | TopShare 0.00% / 11 单 / $594 |
| B3 | 加预算 `drill index` 词 | D1 ★high | ROAS 7.72 / 3 单 / $148 |
| B4 | 加预算 `metal drill bit set for steel` 词 | D1 ★high | ROAS 6.25 / 3 单 / $119 |
| B5 | 加预算 `metric drill bit set` 词 | D1 ☆medium | ROAS 17.03 / 2 单 / $92 |
| B6 | **扩量 attribute_modifier × loose-match 组合** | D3×matchType | ROAS 5.76 / 7 单 / CTR 5.50% |

### 本月规划

| # | 行动 | 来源 |
|---|------|------|
| C1 | 项目级词典化（taxonomy.yaml）| 反哺 7 落地 |
| C2 | D5 爆发词识别实施 | 反哺 10 落地 |
| C3 | D2 互补品：purchased-products 反哺 | D2 + D6 |
| C4 | 配置 `project-configs/4-yuehan.yaml` 落盘 | 用户已确认 |
| C5 | 长尾词 × loose-match 漏斗修复（避免 19 词 0 单）| D3×matchType 漏斗 |

## 12. 待办 / 下一步

| # | 项 | 优先级 | 状态 |
|---|----|--------|------|
| 1 | D5 爆发词识别脚本 | 高 | 待做 |
| 2 | 项目级 taxonomy.yaml 模板 | 高 | 草稿已有 |
| 3 | D6 purchased-products 反哺互补品 | 中 | 待做 |
| 4 | 主题 A（降本）实践 | 中 | 框架已就绪 |
| 5 | 主题 B（提效）实践 | 中 | 框架已就绪 |
| 6 | 主题 E（结构性优化）实践 | 低 | 框架已就绪 |
| 7 | 跨项目对比（peer_project_ids）| 低 | 配置已就绪 |
| 8 | 完整报告输出模板 | 中 | §13 草稿 |

## 13. 报告输出结构（v2.2）

```
报告结构（每份 5-7 节）

1. 摘要（1 页）
2. 活动层诊断（维度 1）
3. 搜索词层诊断（维度 2，最高优先级，含词性分析）
4. 跨维度洞察（主题 A-F 执行结果）
5. 时间窗口对比
6. 行动建议与优先级
7. 附录：数据来源、口径、配置变更
```

## 14. API 端点映射（v2.2）

| 端点 | 维度 | 主题 | 关键字段 |
|------|------|------|---------|
| `/ad-campaigns` | 维度 1 | A/B/E | budget, status, bidding_strategy, campaign_type, targeting_type |
| `/ad-campaigns-raw` | 维度 1 验证 | - | raw_row（中文原始列） |
| `/ad-search-terms` | 维度 2 | A/B/C/D | search_term, match_type, targeting_type |
| `/ad-search-terms-raw` | 维度 2 验证 | - | raw_row |
| `/ad-budgets` | 维度 1 | A/B | suggested_budget, budget_utilization_rate, missed_* |
| `/ad-placements` | 维度 5 | A/C | placement, bidding_strategy, units_7d |
| `/ad-time-trends` | 维度 5 | C | report_end_date（日级） |
| `/ad-targets` | 维度 3 | B/D | target_text, top_of_search_impression_share |
| `/ad-search-term-shares` | 维度 2 | D1 | impression_share（S1 max 聚合） |
| `/ad-promoted-products` | 维度 4 | B | ad_sku, scope_status, ad_sku_*, other_sku_* |
| `/ad-purchased-products` | 维度 4 | D6/D2 | ad_sku, purchased_asin, other_sku_* |
| `/ad-invalid-traffic` | 维度 5 | A/C | invalid_impression_rate |
| `/orders/summary` | 维度 6 | F | is_counted_sales, sku, asin |
| `/ad-upload-files` | 数据完整性 | - | ingestion_status, row_count_preview |

## 15. 框架文件维护

- **本文件**：`docs/superpowers/ad-analysis-framework.md`
- **项目配置**：
  - `project-configs/{id}-{slug}.yaml`（4 档阈值 + 行业基准 + 样本过滤）
  - `project-configs/{id}-{slug}-taxonomy.yaml`（词性分类词典 + 互补品候选）
- **配套 API 文档**：`BLF-广告Agent API 实践指南.md`
- **配套代码**（规划中）：
  - `scripts/ad-analysis/load_data.py`（拉取所有端点）
  - `scripts/ad-analysis/classify_terms.py`（§5 词性分类器 + taxonomy 接入）
  - `scripts/ad-analysis/calc_metrics.py`（§3 阈值 + §6 单位价值 + §3.3 置信度）
  - `scripts/ad-analysis/d5_burst.py`（§9.6 D5 爆发词识别）
  - `scripts/ad-analysis/d2_associate.py`（§9.7 D2 互补品反哺）
  - `scripts/ad-analysis/report.py`（§13 报告生成）
  - `scripts/ad-analysis/d_*.py`（D1-D6 各子主题）

## 16. v2.2 落地文件清单

| 文件 | 内容 | 大小 |
|------|------|------|
| `docs/superpowers/ad-analysis-framework.md` | 框架 v2.2（主文档）| 21.7KB / 479+ 行 |
| `project-configs/4-yuehan-taxonomy.yaml` | 玥涵项目级词性词典 | 2.7KB |

## 17. 主题 D 闭环状态

| 子主题 | 状态 | 关键产出 |
|--------|------|---------|
| D1 | ✅ 重算完成 | 7 强信号 + 置信度过滤 |
| D2 | ✅ 反哺完成 | 4 互补品候选 ASIN + 关联销售 $391.89 |
| D3 | ✅ 词性分析完成 | 8 类 + 单位价值 + 扩量优先级 |
| D4 | ✅ 强信号完成 | 9 提价机会（TopShare<5%） |
| D5 | ✅ 爆发词识别完成 | 1 真爆发（m35 cobalt drill bit set） |
| D6 | ⏳ 待做 | 与 D2 互补品联合分析 |

**主题 D 全部 6 子主题中 5 个已落地**，可进入下一主题（推荐 A 降本 → B 提效）。
