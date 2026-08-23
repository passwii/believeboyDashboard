#!/usr/bin/env python3
"""BLF-798 截图验证用本地 mock 后端（只读 GET；端口 8799）。

端点形态与 gui-api-client 契约一一对应：
- /api/v1/projects/manage
- /api/v1/daily-analysis/all（全部项目模式）
- /api/v1/sku-info（5000 行，展示虚拟化滚动）
"""
import json
import random
from datetime import date, timedelta
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
        return self._send({})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", 8799), Handler)
    print("mock backend on :8799")
    server.serve_forever()
