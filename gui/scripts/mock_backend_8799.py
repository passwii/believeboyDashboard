#!/usr/bin/env python3
"""BLF-798/BLF-799 截图验证用本地 mock 后端（只读 GET；端口 8799）。

端点形态与 gui-api-client 契约一一对应：
- /api/v1/projects/manage
- /api/v1/daily-analysis/all（全部项目模式）
- /api/v1/sku-info（5000 行，展示虚拟化滚动）
- /api/v1/ad-analysis/overview（BLF-799：Pattern B 上半区图表 + 总览 Tab）
- /api/v1/ad-analysis/{tab}（BLF-799：9 个明细 Tab，items 字段与
  gui_domain::advertising::ad_analysis_tabs 列配置一一对应）
- /api/v1/ai/**（BLF-800：Pattern C AI Chat——配置 / 会话 CRUD /
  历史消息 / SSE 流式对话；POST 仅 stream / create / cancel 三类）
"""
import json
import random
import time
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

random.seed(7)

PROJECTS = [
    {"id": 1, "name": "美区旗舰店", "is_active": True},
    {"id": 2, "name": "德国站小店", "is_active": True},
    {"id": 3, "name": "英国站新店", "is_active": True},
]

TODAY = date.today()
DAYS = [str(TODAY - timedelta(days=i)) for i in range(6, -1, -1)]

COUNTRIES = ["US", "DE", "UK"]


def day_row(d: str, mult: float) -> dict:
    return {
        "date": d,
        "order_qty": int(120 * mult + random.randint(-15, 25)),
        "sales_amount": round(4200.0 * mult + random.uniform(-300, 600), 2),
        "impressions": int(52000 * mult),
        "clicks": int(1450 * mult),
        "cpc": round(random.uniform(0.42, 0.66), 2),
        "ad_spend": round(780.0 * mult + random.uniform(-60, 90), 2),
        "ad_orders": int(38 * mult),
        "available_qty": random.randint(180, 2400),
        "page_views": int(8100 * mult),
        "units_ordered": int(158 * mult),
        "sessions": int(3900 * mult),
        "ordered_sales_amount": round(4050.0 * mult, 2),
        "conversion_rate": round(random.uniform(2.4, 4.6), 2),
    }


def detail_row(d: str, i: int) -> dict:
    return {
        "date": d,
        "sku": f"BB-{COUNTRIES[i % 3]}-{i:04d}",
        "asin": f"B0{random.randint(10**6, 10**7-1)}",
        "order_qty": random.randint(0, 26),
        "sales_amount": round(random.uniform(4.9, 380.0), 2),
        "impressions": random.randint(120, 5800),
        "clicks": random.randint(4, 210),
        "cpc": round(random.uniform(0.31, 0.92), 2),
        "ad_spend": round(random.uniform(0, 96.0), 2),
        "ad_orders": random.choice([0, 0, 1, 2, 3]),
        "available_qty": random.choice([random.randint(0, 18), random.randint(19, 900)]),
        "in_transit_qty": random.randint(0, 400),
        "page_views": random.randint(30, 1600),
        "units_ordered": random.randint(0, 24),
        "sessions": random.randint(20, 1400),
        "ordered_sales_amount": round(random.uniform(4.9, 360.0), 2),
        "conversion_rate": round(random.uniform(0.8, 7.4), 2),
    }


SUMMARY = [day_row(d, m) for d, m in zip(DAYS, [0.82, 0.91, 0.77, 1.06, 0.98, 1.21, 1.13])]
DETAILS = []
for di, d in enumerate(DAYS):
    for i in range(18):
        DETAILS.append(detail_row(d, i))

BREAKDOWN = {}
for p in PROJECTS:
    BREAKDOWN[str(p["id"])] = {
        "project_name": p["name"],
        "summary_rows": [
            {**r, "sales_amount": round(r["sales_amount"] / 3, 2)} for r in SUMMARY[2:]
        ],
        "detail_rows": [],
}

SKU_ITEMS = []
for i in range(5000):
    active = random.random() > 0.12
    SKU_ITEMS.append(
        {
            "id": i + 1,
            "project_name": PROJECTS[i % 3]["name"],
            "sku": f"BB-{COUNTRIES[i % 3]}-{i:05d}",
            "asin": f"B0{random.randint(10**6, 10**7-1)}",
            "fob_unit_cost": round(random.uniform(6.0, 88.0), 2),
            "first_leg_cost_rmb": round(random.uniform(3.0, 32.0), 2),
            "package_length_cm": round(random.uniform(8.0, 48.0), 1),
            "package_width_cm": round(random.uniform(6.0, 36.0), 1),
            "package_height_cm": round(random.uniform(2.0, 28.0), 1),
            "weight_kg": round(random.uniform(0.08, 4.2), 2),
            "currency": "USD",
            "country": COUNTRIES[i % 3],
            "sort_order": i,
            "units_per_carton": random.choice([0, 12, 24, 36, 48, 60]),
            "is_active": active,
        }
    )


# ---------------------------------------------------------------------------
# BLF-799：广告分析 mock（overview + 9 个明细 Tab；字段与 gui-domain 列配置一致）
# ---------------------------------------------------------------------------

AD_CAMPAIGNS = [
    "BB-US-Automatic-Broad",
    "BB-US-SponsoredBrand-Exact",
    "BB-DE-Auto-Research",
    "BB-US-PT-Competitor",
    "BB-UK-SB-Video",
    "BB-US-Exact-WaterBottle",
]


def ad_overview() -> dict:
    trend = []
    for i, d in enumerate(DAYS):
        spend = round(random.uniform(60, 220), 2)
        clicks = random.randint(180, 520)
        trend.append(
            {
                "report_date": d,
                "spend": spend,
                "clicks": clicks,
                "cpc": round(spend / max(clicks, 1), 2),
                "spend_change_ratio": round(random.uniform(-0.3, 0.4), 3),
            }
        )
    top_campaigns = [
        {
            "campaign_name": name,
            "spend": round(random.uniform(120, 620), 2),
            "sales_7d": round(random.uniform(900, 5200), 2),
            "orders_7d": random.randint(12, 96),
            "acos": round(random.uniform(0.08, 0.42), 4),
        }
        for name in AD_CAMPAIGNS
    ]
    return {
        "project_id": 1,
        "country": "US",
        "metrics": [
            {"label": "花费", "value": 3186.4, "display_value": "$3,186.40", "helper": "近 7 天"},
            {"label": "销售", "value": 24810.0, "display_value": "$24,810.00", "helper": None},
            {"label": "ACOS", "value": 0.1284, "display_value": "12.84%", "helper": None},
            {"label": "ROAS", "value": 7.79, "display_value": "7.79", "helper": None},
        ],
        "issue_cards": [
            {
                "title": "高 ACOS 活动",
                "level": "warning",
                "summary": "BB-US-PT-Competitor ACOS 42%，高于目标阈值",
                "drill_to": "campaigns",
                "next_step": "检查竞品投放出价",
            }
        ],
        "narrative_sections": [
            {
                "title": "花费趋势",
                "summary": "花费环比上升 12%，销售增长更快，整体健康",
                "evidence": ["花费 +12%", "销售 +21%"],
                "action": None,
                "drill_to": "time-trend",
            }
        ],
        "comparison": {
            "current_start": DAYS[0],
            "current_end": DAYS[-1],
            "previous_start": str(date.fromisoformat(DAYS[0]) - timedelta(days=7)),
            "previous_end": str(date.fromisoformat(DAYS[-1]) - timedelta(days=7)),
            "spend_change_ratio": 0.12,
            "clicks_change_ratio": 0.06,
            "sales_change_ratio": 0.21,
            "orders_change_ratio": 0.15,
            "cpc_change_ratio": 0.05,
            "acos_change_ratio": -0.07,
            "summary": "花费上升但销售增长更快",
        },
        "top_campaigns": top_campaigns,
        "top_products": [
            {
                "ad_sku": f"BB-US-{i:04d}",
                "spend": round(random.uniform(40, 320), 2),
                "sales_7d": round(random.uniform(300, 2600), 2),
                "orders_7d": random.randint(5, 48),
                "acos": round(random.uniform(0.07, 0.38), 4),
            }
            for i in range(6)
        ],
        "top_waste_terms": [
            {
                "search_term": term,
                "campaign_name": AD_CAMPAIGNS[i % len(AD_CAMPAIGNS)],
                "clicks": random.randint(20, 90),
                "spend": round(random.uniform(8, 46), 2),
                "orders_7d": 0,
            }
            for i, term in enumerate(["water bottle lid", "bpa free jug", "insulated cup 32oz"])
        ],
        "trend_summary": trend,
    }


def _campaign_row(i: int) -> dict:
    spend = round(random.uniform(40, 620), 2)
    sales = round(spend * random.uniform(2.4, 9.0), 2)
    orders = random.randint(3, 96)
    impressions = random.randint(2400, 42000)
    clicks = random.randint(60, 1400)
    return {
        "campaign_name": AD_CAMPAIGNS[i % len(AD_CAMPAIGNS)],
        "status": random.choice(["ENABLED", "ENABLED", "PAUSED"]),
        "targeting_type": random.choice(["AUTO", "MANUAL", "SPONSORED_BRAND"]),
        "bidding_strategy": random.choice(["DOWN_ONLY", "UP_AND_DOWN"]),
        "budget": round(random.uniform(30, 300), 2),
        "impressions": impressions,
        "clicks": clicks,
        "ctr": round(clicks / max(impressions, 1), 4),
        "cpc": round(spend / max(clicks, 1), 2),
        "spend": spend,
        "sales_7d": sales,
        "orders_7d": orders,
        "acos": round(spend / max(sales, 1), 4),
        "roas": round(sales / max(spend, 1), 2),
        "grade": random.choice(["A", "A", "B", "C"]),
        "budget_gap": round(random.uniform(0, 80), 2),
        "budget_utilization_rate": round(random.uniform(0.3, 1.0), 4),
        "cross_sell_orders_7d": random.randint(0, 12),
        "cross_sell_sales_7d": round(random.uniform(0, 420), 2),
        "cross_sell_action": random.choice(["暂无关联转化", "关联转化健康"]),
        "next_action": random.choice(["维持预算", "加预算候选", "否词降价"]),
    }


AD_TAB_ITEMS = {
    "time-trend": {
        "project_id": 1,
        "country": "US",
        "summary": [],  # AD_OVERVIEW 生成后回填（见文件尾部）
        "comparison": None,
    },
    "campaigns": {
        "project_id": 1,
        "country": "US",
        "summary_cards": [
            {"label": "活动数", "value": "6", "helper": None},
            {"label": "总花费", "value": "$1,864.20", "helper": "近 7 天"},
        ],
        "narrative_sections": [],
        "items": [_campaign_row(i) for i in range(6)] + [_campaign_row(i) for i in range(6)],
    },
    "products": {
        "project_id": 1,
        "country": "US",
        "summary_cards": [{"label": "推广 SKU 数", "value": "24", "helper": None}],
        "narrative_sections": [],
        "items": [
            {
                "ad_sku": f"BB-US-{i:04d}",
                "ad_asin": f"B0{random.randint(10**6, 10**7-1)}",
                "grade": random.choice(["A", "B", "B", "C"]),
                "primary_campaign": AD_CAMPAIGNS[i % len(AD_CAMPAIGNS)],
                "impressions": random.randint(900, 26000),
                "clicks": random.randint(30, 860),
                "ctr": round(random.uniform(0.0012, 0.048), 4),
                "cpc": round(random.uniform(0.28, 0.96), 2),
                "spend": round(random.uniform(18, 420), 2),
                "sales_7d": round(random.uniform(120, 4200), 2),
                "orders_7d": random.randint(2, 66),
                "units_7d": random.randint(2, 80),
                "cvr_7d": round(random.uniform(0.04, 0.22), 4),
                "acos": round(random.uniform(0.06, 0.44), 4),
                "cross_sell_orders_7d": random.randint(0, 9),
                "cross_sell_sales_7d": round(random.uniform(0, 380), 2),
                "next_action": random.choice(["维持", "放量", "查落地页"]),
            }
            for i in range(24)
        ],
    },
    "purchased-products": {
        "project_id": 1,
        "country": "US",
        "items": [
            {
                "purchased_asin": f"B0{random.randint(10**6, 10**7-1)}",
                "ad_sku": f"BB-US-{i:04d}",
                "campaign_count": random.randint(1, 4),
                "other_sku_units_7d": random.randint(0, 26),
                "other_sku_orders_7d": random.randint(0, 14),
                "other_sku_sales_7d": round(random.uniform(0, 620), 2),
                "action": random.choice(["关联转化健康", "暂无关联转化"]),
            }
            for i in range(12)
        ],
    },
    "search-terms": {
        "project_id": 1,
        "country": "US",
        "summary_cards": [{"label": "搜索词数", "value": "48", "helper": "近 7 天"}],
        "narrative_sections": [],
        "items": [
            {
                "search_term": random.choice(
                    ["water bottle", "insulated jug", "gym flask 32oz", "steel tumbler", "bpa free bottle"]
                )
                + f" {i}",
                "match_type": random.choice(["EXACT", "PHRASE", "BROAD"]),
                "primary_campaign": AD_CAMPAIGNS[i % len(AD_CAMPAIGNS)],
                "impressions": random.randint(400, 12000),
                "clicks": random.randint(8, 420),
                "ctr": round(random.uniform(0.001, 0.06), 4),
                "cpc": round(random.uniform(0.24, 1.1), 2),
                "spend": round(random.uniform(4, 260), 2),
                "sales_7d": round(random.uniform(0, 2400), 2),
                "orders_7d": random.randint(0, 38),
                "cvr_7d": round(random.uniform(0.0, 0.24), 4),
                "acos": round(random.uniform(0.05, 0.6), 4),
                "impression_share": round(random.uniform(0.02, 0.6), 4),
                "impression_rank": random.randint(1, 40),
                "action": random.choice(["保留", "否词候选", "提竞价"]),
            }
            for i in range(48)
        ],
    },
    "targets": {
        "project_id": 1,
        "country": "US",
        "summary_cards": [{"label": "投放对象数", "value": "32", "helper": None}],
        "narrative_sections": [],
        "items": [
            {
                "target_text": random.choice(
                    ["close-match", "loose-match", "substitutes", "complements", f"asin-{i}"]
                ),
                "match_type": random.choice(["CLOSE_MATCH", "SUBSTITUTES", "EXACT"]),
                "primary_campaign": AD_CAMPAIGNS[i % len(AD_CAMPAIGNS)],
                "impressions": random.randint(500, 15000),
                "clicks": random.randint(10, 460),
                "ctr": round(random.uniform(0.001, 0.05), 4),
                "cpc": round(random.uniform(0.26, 1.05), 2),
                "spend": round(random.uniform(5, 300), 2),
                "sales_7d": round(random.uniform(0, 2800), 2),
                "orders_7d": random.randint(0, 42),
                "cvr_7d": round(random.uniform(0.0, 0.2), 4),
                "acos": round(random.uniform(0.06, 0.55), 4),
                "top_of_search_impression_share": round(random.uniform(0.05, 0.8), 4),
                "action": random.choice(["维持", "隔离降价", "精细化承接"]),
            }
            for i in range(32)
        ],
    },
    "placements": {
        "project_id": 1,
        "country": "US",
        "summary_cards": [{"label": "广告位记录", "value": "18", "helper": None}],
        "narrative_sections": [],
        "items": [
            {
                "placement": random.choice(
                    ["Top of Search on-Amazon", "Rest of Search on-Amazon", "Product pages on-Amazon"]
                ),
                "campaign_name": AD_CAMPAIGNS[i % len(AD_CAMPAIGNS)],
                "impressions": random.randint(600, 18000),
                "clicks": random.randint(12, 520),
                "ctr": round(random.uniform(0.001, 0.055), 4),
                "cpc": round(random.uniform(0.3, 1.2), 2),
                "spend": round(random.uniform(6, 340), 2),
                "sales_7d": round(random.uniform(0, 3200), 2),
                "orders_7d": random.randint(0, 46),
                "units_7d": random.randint(0, 52),
                "cvr_7d": round(random.uniform(0.02, 0.2), 4),
                "acos": round(random.uniform(0.07, 0.5), 4),
                "roas": round(random.uniform(1.8, 12.0), 2),
                "action": random.choice(["可提高系数", "谨慎降价", "流量偏弱"]),
            }
            for i in range(18)
        ],
    },
    "budget": {
        "project_id": 1,
        "country": "US",
        "summary_cards": [
            {"label": "预算受限活动", "value": "3", "helper": None},
            {"label": "预计错失销售", "value": "$1,240", "helper": "近 7 天"},
        ],
        "narrative_sections": [],
        "items": [
            {
                "campaign_name": AD_CAMPAIGNS[i % len(AD_CAMPAIGNS)],
                "status": "ENABLED",
                "budget": round(random.uniform(30, 200), 2),
                "suggested_budget": round(random.uniform(60, 420), 2),
                "budget_gap": round(random.uniform(0, 120), 2),
                "budget_utilization_rate": round(random.uniform(0.4, 1.0), 4),
                "missed_sales_min": round(random.uniform(0, 180), 2),
                "missed_sales_max": round(random.uniform(180, 620), 2),
                "spend": round(random.uniform(20, 380), 2),
                "sales_7d": round(random.uniform(100, 3600), 2),
                "orders_7d": random.randint(4, 60),
                "acos": round(random.uniform(0.07, 0.4), 4),
                "next_step": random.choice(["加预算候选", "先优化词路", "维持"]),
            }
            for i in range(6)
        ],
    },
    "traffic-quality": {
        "project_id": 1,
        "country": "US",
        "summary_cards": [{"label": "无效点击率", "value": "1.82%", "helper": "近 7 天"}],
        "narrative_sections": [],
        "items": [
            {
                "campaign_name": AD_CAMPAIGNS[i % len(AD_CAMPAIGNS)],
                "status": "ENABLED",
                "risk_level": random.choice(["正常", "正常", "观察", "高风险"]),
                "total_impressions": random.randint(2000, 40000),
                "invalid_impressions": random.randint(10, 400),
                "invalid_impression_rate": round(random.uniform(0.001, 0.03), 4),
                "total_clicks": random.randint(60, 1500),
                "invalid_clicks": random.randint(0, 30),
                "invalid_click_rate": round(random.uniform(0.0, 0.04), 4),
                "next_step": random.choice(["持续观察", "排查入口结构", "暂停排查"]),
            }
            for i in range(6)
        ],
    },
}

AD_OVERVIEW = ad_overview()

# ---------------------------------------------------------------------------
# BLF-800：AI Chat mock（配置 / 会话 / 消息 / SSE 流）
# ---------------------------------------------------------------------------

_NOW = datetime.now(timezone.utc)


def _iso(minutes_ago: float) -> str:
    return (_NOW - timedelta(minutes=minutes_ago)).isoformat()


AI_CONFIG = {
    "provider_configured": True,
    "web_search_configured": True,
    "models": ["believeboy-flash", "believeboy-pro", "claude-sonnet"],
    "default_model": "believeboy-flash",
    "timeout_seconds": 120,
}

_AI_REPLY_TEMPLATE = (
    "这是 **mock 流式回复**（BLF-800 Pattern C 验证数据）。\n\n"
    "## 销售表现小结\n\n"
    "| 站点 | GMV | 环比 |\n|---|---|---|\n"
    "| US | $128,400 | +12.3% |\n| DE | €46,120 | -2.1% |\n\n"
    "- 建议关注 **DE 站** ACoS 走高\n"
    "- US 站库存周转健康\n\n"
    "`代码块` 与 *行内样式* 均可渲染；本回复超过 2000 字符时仍应保持"
    "滚动跟随流畅、上翻即暂停。"
)

AI_CONVERSATIONS = [
    {
        "id": 7,
        "title": "上周销售数据分析",
        "created_at": _iso(600),
        "updated_at": _iso(30),
        "total_prompt_tokens": 320,
        "total_completion_tokens": 1450,
        "total_tokens": 1770,
    },
    {
        "id": 5,
        "title": "广告活动优化建议",
        "created_at": _iso(2880),
        "updated_at": _iso(1500),
        "total_prompt_tokens": 180,
        "total_completion_tokens": 620,
        "total_tokens": 800,
    },
]

AI_MESSAGES = {
    7: [
        {
            "id": 1,
            "conversation_id": 7,
            "role": "user",
            "content": "帮我总结一下上周的销售表现，重点看美区。",
            "search_sources": [],
            "is_complete": True,
            "total_tokens": 0,
            "created_at": _iso(32),
        },
        {
            "id": 2,
            "conversation_id": 7,
            "role": "assistant",
            "content": (
                "## 上周销售小结\n\nUS 站 GMV $128,400（环比 **+12.3%**），"
                "主要由 Prime Day 尾量拉动；DE 站小幅回落。\n\n"
                "| 站点 | GMV | 环比 |\n|---|---|---|\n"
                "| US | $128,400 | +12.3% |\n| DE | €46,120 | -2.1% |"
            ),
            "search_sources": [],
            "is_complete": True,
            "prompt_tokens": 160,
            "completion_tokens": 720,
            "total_tokens": 880,
            "duration_ms": 2100,
            "created_at": _iso(31),
        },
    ],
    5: [],
}
_NEXT_CONV_ID = 100
_NEXT_MSG_ID = 1000
_running = 0.0
for _t in AD_OVERVIEW["trend_summary"]:
    _running += _t["spend"]
    AD_TAB_ITEMS["time-trend"]["summary"].append(
        {
            "report_date": _t["report_date"],
            "clicks": _t["clicks"],
            "spend": _t["spend"],
            "cpc": _t["cpc"],
            "running_spend": round(_running, 2),
            "spend_change_ratio": _t["spend_change_ratio"],
        }
    )


class Handler(BaseHTTPRequestHandler):
    def _send(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/v1/projects/manage":
            return self._send(PROJECTS)
        if path == "/api/v1/ad-analysis/overview":
            return self._send(AD_OVERVIEW)
        if path.startswith("/api/v1/ad-analysis/"):
            tab = path.rsplit("/", 1)[-1]
            if tab in AD_TAB_ITEMS:
                return self._send(AD_TAB_ITEMS[tab])
            return self._send({"project_id": 1, "country": "US", "items": []})
        if path == "/api/v1/daily-analysis/all":
            return self._send(
                {
                    "summary_rows": SUMMARY,
                    "detail_rows": DETAILS,
                    "available_dates": {},
                    "project_breakdown": BREAKDOWN,
                }
            )
        if path == "/api/v1/sku-info":
            q = self.path
            page = 1
            page_size = 100
            if "page=" in q:
                import urllib.parse

                params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                page = int(params.get("page", ["1"])[0])
                page_size = int(params.get("page_size", ["100"])[0])
                keyword = (params.get("sku") or [""])[0].lower()
                country = (params.get("country") or [""])[0]
                is_active = (params.get("is_active") or [""])[0]
                items = SKU_ITEMS
                if keyword:
                    items = [r for r in items if keyword in r["sku"].lower()]
                if country and country != "ALL":
                    items = [r for r in items if r["country"] == country]
                if is_active in ("true", "false"):
                    want = is_active == "true"
                    items = [r for r in items if r["is_active"] == want]
                total = len(items)
                start = (page - 1) * page_size
                return self._send(
                    {
                        "items": items[start : start + page_size],
                        "page": page,
                        "page_size": page_size,
                        "total": total,
                        "has_next": start + page_size < total,
                    }
                )
            return self._send(
                {
                    "items": SKU_ITEMS[:page_size],
                    "page": page,
                    "page_size": page_size,
                    "total": len(SKU_ITEMS),
                    "has_next": True,
                }
            )
        if path == "/api/v1/ai/config":
            return self._send(AI_CONFIG)
        if path == "/api/v1/ai/conversations":
            return self._send(AI_CONVERSATIONS)
        if path.startswith("/api/v1/ai/conversations/") and path.endswith("/messages"):
            conv_id = int(path.split("/")[5])
            return self._send(AI_MESSAGES.get(conv_id, []))
        return self._send({})

    def do_POST(self):
        global _NEXT_CONV_ID, _NEXT_MSG_ID
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b"{}"
        path = self.path.split("?")[0]
        if path == "/api/v1/ai/conversations":
            _NEXT_CONV_ID += 1
            conv = {
                "id": _NEXT_CONV_ID,
                "title": "新对话",
                "created_at": _iso(0),
                "updated_at": _iso(0),
                "total_prompt_tokens": 0,
                "total_completion_tokens": 0,
                "total_tokens": 0,
            }
            AI_CONVERSATIONS.insert(0, conv)
            AI_MESSAGES[conv["id"]] = []
            return self._send(conv)
        if path.endswith("/cancel"):
            return self._send({"ok": True})
        if path.endswith("/messages/stream"):
            parts = path.split("/")
            conv_id = int(parts[5]) if len(parts) > 5 else 7
            try:
                req = json.loads(body or b"{}")
            except ValueError:
                req = {}
            user_content = str(req.get("content") or "")
            return self._stream_chat(conv_id, user_content)
        return self._send({})

    def _stream_chat(self, conv_id: int, user_content: str):
        """Anthropic Messages 形 SSE：message_start → text_delta* → done。"""
        global _NEXT_MSG_ID
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def emit(payload):
            chunk = (f"data: {json.dumps(payload, ensure_ascii=False)}\n\n").encode()
            self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
            self.wfile.flush()

        model = "believeboy-flash"
        emit({"type": "message_start", "message_id": f"m-{_NEXT_MSG_ID}", "model": model})
        emit({
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "text", "text": ""},
        })
        reply = _AI_REPLY_TEMPLATE
        # 按 ~8 字符粒度切块，模拟逐 token 推进（总时长 ~2.5s，便于观察跟随）
        for i in range(0, len(reply), 8):
            emit({
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": reply[i : i + 8]},
            })
            time.sleep(0.02)
        emit({"type": "content_block_stop"})
        emit({"type": "message_delta", "usage": {"input_tokens": 64, "output_tokens": 512}})
        emit({"type": "message_stop"})

        now = _iso(0)
        assistant_message = {
            "id": _NEXT_MSG_ID + 1,
            "conversation_id": conv_id,
            "role": "assistant",
            "content": reply,
            "search_sources": [],
            "is_complete": True,
            "prompt_tokens": 64,
            "completion_tokens": 512,
            "total_tokens": 576,
            "duration_ms": 2400,
            "created_at": now,
        }
        user_message = {
            "id": _NEXT_MSG_ID,
            "conversation_id": conv_id,
            "role": "user",
            "content": user_content,
            "search_sources": [],
            "is_complete": True,
            "total_tokens": 0,
            "created_at": now,
        }
        _NEXT_MSG_ID += 2
        AI_MESSAGES.setdefault(conv_id, []).extend([user_message, assistant_message])
        for conv in AI_CONVERSATIONS:
            if conv["id"] == conv_id:
                conv["updated_at"] = now
                conv["total_tokens"] += 576
        emit({
            "type": "done",
            "user_message": user_message,
            "assistant_message": assistant_message,
            "conversation_title": None,
            "token_usage": {"prompt_tokens": 64, "completion_tokens": 512, "total_tokens": 576},
            "duration_ms": 2400,
            "title_regenerated": False,
        })
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def do_DELETE(self):
        path = self.path.split("?")[0]
        parts = path.split("/")
        if len(parts) == 6 and parts[4] == "conversations":
            conv_id = int(parts[5])
            AI_CONVERSATIONS[:] = [c for c in AI_CONVERSATIONS if c["id"] != conv_id]
            self.send_response(204)
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8799), Handler)
    print("mock backend on :8799")
    server.serve_forever()
