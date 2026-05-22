# P2 计划：AI 洞察注入

> 目标：将项目背景配置注入到 AI 洞察生成的 Prompt 中，使 AI 能够结合业务上下文做出准确判断

---

## 步骤概览

```
P2
├── 2.1 AggregatedData 数据结构更新
├── 2.2 读取背景信息逻辑
├── 2.3 Prompt 注入
├── 2.4 使用规则约束
└── 2.5 空数据处理
```

---

## 2.1 AggregatedData 数据结构更新

**目标**：`AggregatedData` dataclass 新增 `project_context` 和 `sku_context` 字段

**文件**：`backend/app/services/ai_insight_aggregator.py`

**改动**：

```python
@dataclass
class AggregatedData:
    project_name: str
    country: str
    date_range_start: date
    date_range_end: date
    sales_by_date: list[dict[str, Any]] = field(default_factory=list)
    ad_by_date: list[dict[str, Any]] = field(default_factory=list)
    inventory_summary: dict[str, Any] = field(default_factory=dict)
    comparison_period: dict[str, Any] | None = None
    top_skus: list[dict[str, Any]] = field(default_factory=list)
    ad_campaigns: list[dict[str, Any]] = field(default_factory=list)
    data_coverage: dict[str, Any] = field(default_factory=dict)
    # 新增
    project_context: dict[str, Any] = field(default_factory=dict)
    sku_context: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "project_name": self.project_name,
            "country": self.country,
            "date_range_start": self.date_range_start.isoformat(),
            "date_range_end": self.date_range_end.isoformat(),
            "sales_by_date": self.sales_by_date,
            "ad_by_date": self.ad_by_date,
            "inventory_summary": self.inventory_summary,
            "comparison_period": self.comparison_period,
            "top_skus": self.top_skus,
            "ad_campaigns": self.ad_campaigns,
            "data_coverage": self.data_coverage,
            # 新增
            "project_context": self.project_context,
            "sku_context": self.sku_context,
        }
```

**验证方式**：
```bash
cd backend && python -c "
from app.services.ai_insight_aggregator import AggregatedData
from datetime import date
d = AggregatedData('test', 'US', date.today(), date.today())
d.project_context = {'factory': {'description': 'test'}}
d.sku_context = {'SKU001': {'status': '清仓'}}
print(d.to_dict())
"
```

---

## 2.2 读取背景信息逻辑

**目标**：在 `aggregate_project_data()` 函数中读取并注入项目背景信息

**文件**：`backend/app/services/ai_insight_aggregator.py`

**改动位置**：找到 `run_queries()` 函数内，创建 `AggregatedData` 实例时传入背景信息

**前置准备**：在文件顶部新增导入

```python
from app.services import project_service
```

**改动**：

```python
def aggregate_project_data(
    db: Session,
    project_id: int,
    country: str,
    start_date: date,
    end_date: date,
    progress_cb: ProgressCallback | None = None,
) -> AggregatedData | None:
    project = _get_project_or_404(db, project_id)
    if project is None:
        return None

    # ... 现有逻辑 ...

    def run_queries():
        # ... 现有并行查询逻辑保持不变 ...

        # 获取项目背景信息（在查询完成后执行）
        project_context, sku_context = project_service.get_project_context(db, project_id)

        return AggregatedData(
            project_name=project.project_name,
            country=country,
            date_range_start=start_date,
            date_range_end=end_date,
            sales_by_date=sales_by_date,
            ad_by_date=ad_by_date,
            inventory_summary=inventory_summary,
            comparison_period=comparison_period,
            top_skus=top_skus,
            ad_campaigns=ad_campaigns,
            data_coverage={
                "sales_days": sales_coverage["days"],
                "ad_days": ad_coverage["days"],
                "total_requested_days": len(_daterange(start_date, end_date)),
            },
            # 新增
            project_context=project_context or {},
            sku_context=sku_context or {},
        )

    return run_queries()
```

**验证方式**：
```bash
# 需要先确保 P0 完成的 API 能正常工作
# 然后在 Python 中测试
cd backend && python -c "
from app.db.session import SessionLocal
from app.services.ai_insight_aggregator import aggregate_project_data
from datetime import date
db = SessionLocal()
result = aggregate_project_data(db, 1, 'US', date(2024, 1, 1), date(2024, 1, 31))
print('project_context:', result.project_context)
print('sku_context:', result.sku_context)
db.close()
"
```

---

## 2.3 Prompt 注入

**目标**：在 AI 洞察生成的系统 Prompt 中注入项目背景信息

**文件**：`backend/app/services/ai_insight_generator.py`

**新增辅助函数**：

```python
def _format_project_context_for_prompt(context: dict[str, Any]) -> str:
    """将 project_context 格式化为可读的文本片段"""
    if not context:
        return "（暂无项目背景信息）"

    lines = []
    mapping = {
        "factory": "🏭 工厂供货",
        "productSeasonality": "📦 淡旺季",
        "productGrowth": "📈 产品增长",
        "projectStatus": "📊 项目状态",
    }

    for key, label in mapping.items():
        if key in context and context[key]:
            section = context[key]
            parts = []
            # factory
            if key == "factory":
                if section.get("description"):
                    parts.append(f"说明：{section['description']}")
                if section.get("productionCapacity"):
                    parts.append(f"生产能力：{section['productionCapacity']}")
                if section.get("communication"):
                    parts.append(f"沟通协作：{section['communication']}")
            # productSeasonality
            elif key == "productSeasonality":
                if section.get("peakSeason"):
                    parts.append(f"高峰期：{section['peakSeason']}")
                if section.get("offSeason"):
                    parts.append(f"淡季：{section['offSeason']}")
                if section.get("restockStrategy"):
                    parts.append(f"备货策略：{section['restockStrategy']}")
            # productGrowth
            elif key == "productGrowth":
                if section.get("description"):
                    parts.append(f"说明：{section['description']}")
                if section.get("growthDriver"):
                    parts.append(f"增长驱动：{section['growthDriver']}")
            # projectStatus
            elif key == "projectStatus":
                if section.get("description"):
                    parts.append(f"说明：{section['description']}")
                if section.get("riskNotes"):
                    parts.append(f"风险备注：{section['riskNotes']}")

            if parts:
                lines.append(f"**{label}**：{'；'.join(parts)}")

    # 自由备注
    if context.get("notes"):
        lines.append(f"**📝 自由备注**：{context['notes']}")

    return "\n".join(lines) if lines else "（暂无项目背景信息）"


def _format_sku_context_for_prompt(context: dict[str, Any]) -> str:
    """将 sku_context 格式化为可读的文本片段"""
    if not context:
        return "（暂无 SKU 特殊状态）"

    lines = []
    for sku, item in context.items():
        parts = []
        if item.get("status"):
            parts.append(f"状态：{item['status']}")
        if item.get("reason"):
            parts.append(f"原因：{item['reason']}")
        if item.get("action"):
            parts.append(f"行动：{item['action']}")
        if item.get("startDate"):
            parts.append(f"开始日期：{item['startDate']}")
        if item.get("endDate"):
            parts.append(f"结束日期：{item['endDate']}")

        if parts:
            lines.append(f"- **{sku}**：{'；'.join(parts)}")

    return "\n".join(lines) if lines else "（暂无 SKU 特殊状态）"
```

**改动 `build_insight_messages()` 函数**：

```python
def build_insight_messages(
    data: dict[str, Any],
    user_message: str | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Build system prompt and user message for insight generation."""
    data_str = json.dumps(data, ensure_ascii=False, indent=2)

    system_prompt = INSIGHT_SYSTEM_PROMPT.strip()

    # 构建项目背景信息片段
    project_context = data.get("project_context", {})
    sku_context = data.get("sku_context", {})
    project_context_text = _format_project_context_for_prompt(project_context)
    sku_context_text = _format_sku_context_for_prompt(sku_context)

    # 在 user_content 中追加背景信息
    user_content = f"""请根据以下数据生成洞察报告：

## 数据
```json
{data_str}
```

## 项目背景信息（由运营人员填写，生成洞察时请结合以下信息进行综合分析）

### 项目背景
{project_context_text}

### SKU 特殊状态
{sku_context_text}
"""

    if user_message:
        user_content += f"\n\n用户补充说明：{user_message}"

    return system_prompt, [{"role": "user", "content": user_content}]
```

**验证方式**：
```bash
cd backend && python -c "
from app.services.ai_insight_generator import build_insight_messages, _format_project_context_for_prompt, _format_sku_context_for_prompt

# 测试格式化函数
ctx = {
    'factory': {'description': '深圳工厂，交货周期 15 天', 'productionCapacity': '月产 5000 件'},
    'productSeasonality': {'peakSeason': 'Q4 为旺季', 'offSeason': 'Q2 淡季'},
    'notes': '暂无'
}
print(_format_project_context_for_prompt(ctx))

sku_ctx = {'SKU001': {'status': '清仓', 'reason': '库龄超过 270 天'}}
print(_format_sku_context_for_prompt(sku_ctx))
"
```

---

## 2.4 使用规则约束

**目标**：在系统 Prompt 中增加背景信息使用规则，指导 AI 正确解读数据

**文件**：`backend/app/services/ai_insight_generator.py`

**改动位置**：`INSIGHT_SYSTEM_PROMPT` 末尾新增章节

```python
INSIGHT_SYSTEM_PROMPT = """你是一位专业的跨境电商数据分析师，为Amazon卖家提供经营洞察。

你的任务是根据提供的经营数据，生成一份结构化的Markdown格式经营洞察报告。

# ... 现有内容保持不变 ... """

# 新增以下内容到 INSIGHT_SYSTEM_PROMPT 末尾

## 项目背景信息使用规则

生成洞察时必须遵循以下规则，结合运营人员提供的背景信息进行综合分析：

### 销量异常解读
- 如果某 SKU 正在"清仓"或做"促销/秒杀"活动，其销量增长应归因于促销活动而非自然增长
- 在分析中明确标注"促销驱动的增长"，不要将此类增长完全归功于运营策略

### 淡旺季判断
- 如果项目背景中标注了高峰期（如 Q4）和淡季（如 Q2），应将其作为正常季节性表现
- 不要将旺季销量高于淡季作为运营评价的加分项

### 库存分析
- 结合备货周期信息（如"交货周期 15 天"），判断当前库存水位是否合理
- 如果背景说"产能充足"但库存经常断货，需在洞察中特别指出矛盾

### 风险标注
- 如果发现数据与背景信息矛盾，应在洞察中明确指出
- 例如："广告数据表现不佳，但考虑到该项目为新开项目（爬坡期），此情况属正常"

### 运营评价边界
- 结合项目状态（新项目/增长期/成熟期）调整评价标准
- 新项目应以"是否按计划推进"为主要评价维度，而非绝对业绩

---

请根据以上规则和提供的项目背景信息，生成客观、准确的洞察报告。
"""
```

---

## 2.5 空数据处理

**目标**：确保没有背景信息时，洞察生成不受影响

**检查项**：

1. `aggregate_project_data()` 中 `project_context or {}` 确保返回空字典而非 None
2. `_format_project_context_for_prompt()` 接收空字典时返回"（暂无项目背景信息）"
3. `_format_sku_context_for_prompt()` 接收空字典时返回"（暂无 SKU 特殊状态）"

**验证场景**：

| 场景 | 预期结果 |
|------|----------|
| 新项目无任何背景信息 | 洞察正常生成，Prompt 中显示"（暂无项目背景信息）" |
| 部分维度有值，部分为空 | 只显示有值的维度 |
| 有背景信息但洞察生成失败 | 不影响错误处理逻辑 |
| 背景信息格式错误 | 后端 JSON 解析失败时返回 500，前端提示错误 |

**测试用例**：

```python
# 场景 1：完全空的背景
result = aggregate_project_data(db, 999, 'US', date(2024,1,1), date(2024,1,31))
assert result.project_context == {}
assert result.sku_context == {}

# 场景 2：部分维度有值
# ...（需要测试数据）

# 场景 3：格式错误的 JSON（需数据库层面测试）
```

---

## 验证测试用例

### 1. 数据结构验证
- [ ] `AggregatedData.to_dict()` 包含 `project_context` 和 `sku_context`
- [ ] 空字典时返回 `{}` 而非 `None`

### 2. 格式化函数验证
```bash
# 空输入
_format_project_context_for_prompt({})
# 预期：（暂无项目背景信息）

# 有值
_format_project_context_for_prompt({
    'factory': {'description': '深圳工厂'}
})
# 预期：**🏭 工厂供货**：说明：深圳工厂
```

### 3. Prompt 注入验证
```bash
# 构造包含背景信息的数据
data = {
    'project_name': '测试项目',
    'country': 'US',
    'date_range_start': '2024-01-01',
    'date_range_end': '2024-01-31',
    'sales_by_date': [],
    'project_context': {'factory': {'description': '测试'}},
    'sku_context': {}
}
system, messages = build_insight_messages(data)
assert '项目背景信息' in messages[0]['content']
assert '测试' in messages[0]['content']
```

### 4. 端到端验证
- [ ] 生成一个已知有背景信息的项目的洞察
- [ ] 确认 AI 在洞察中引用了背景信息
- [ ] 确认使用规则生效（清仓 SKU 销量增长不归功于运营）

---

## 预计产出

完成 P2 后，AI 洞察能够：

| 功能 | 说明 |
|------|------|
| 读取背景信息 | 自动获取项目的工厂供货、淡旺季、产品增长、项目状态 |
| 读取 SKU 状态 | 自动获取 SKU 特殊状态（清仓、秒杀等） |
| 注入 Prompt | 将背景信息格式化为可读文本注入到 LLM |
| 规则约束 | AI 不会将促销驱动的增长归功于运营 |
| 空数据兼容 | 无背景信息时正常生成洞察 |