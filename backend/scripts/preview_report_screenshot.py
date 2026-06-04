#!/usr/bin/env python3
"""本地预览 schedule report 截图效果。

生成一份模拟数据的日报 + 周报截图，保存到本地文件，不上传 R2、不发邮件。

用法:
    cd backend
    python scripts/preview_report_screenshot.py
    # 截图保存到 .agent-contexts/report_preview/
"""

import os
import sys

# ── 模拟数据 ─────────────────────────────────────────────────────────────────

MOCK_DAILY_DATA = {
    "project_name": "BLF 测试项目",
    "country": "US",
    "report_date": "2026-06-04",
    "date_range": "05-29 ~ 06-04",
    "ai_summary": "昨日销量环比上升 25%，销售额突破 $5,000。库存方面有 2 个 SKU 告急，建议尽快补货。广告 ROAS 维持在 2.5 以上，表现健康。",
    "sales": {
        "yesterday_qty": 47,
        "yesterday_amount": 5234.56,
        "prev_qty": 38,
        "change_pct": 23.7,
    },
    "week_sales": {"week_qty": 312, "week_amount": 34567.89},
    "trend_days": [
        {"date": "05-29", "qty": 35},
        {"date": "05-30", "qty": 42},
        {"date": "05-31", "qty": 38},
        {"date": "06-01", "qty": 51},
        {"date": "06-02", "qty": 45},
        {"date": "06-03", "qty": 54},
        {"date": "06-04", "qty": 47},
    ],
    "top_skus": [
        {"sku": "BLF-WIDGET-A", "qty": 89, "amount": 8912.30},
        {"sku": "BLF-GADGET-B", "qty": 67, "amount": 6734.50},
        {"sku": "BLF-SENSOR-C", "qty": 52, "amount": 4156.00},
        {"sku": "BLF-CABLE-D", "qty": 48, "amount": 2390.40},
        {"sku": "BLF-CHARGER-E", "qty": 36, "amount": 1872.00},
    ],
    "sku_sales_detail": [
        {"sku": "BLF-WIDGET-A", "product_name": "Premium Widget Pro Max", "qty": 12, "amount": 1200.00},
        {"sku": "BLF-GADGET-B", "product_name": "Smart Gadget Ultra", "qty": 8, "amount": 856.50},
        {"sku": "BLF-SENSOR-C", "product_name": "Temperature Sensor V3", "qty": 6, "amount": 480.00},
        {"sku": "BLF-CABLE-D", "product_name": "USB-C Cable 2m", "qty": 15, "amount": 450.00},
        {"sku": "BLF-CHARGER-E", "product_name": "Fast Charger 65W", "qty": 6, "amount": 648.00},
    ],
    "inventory": {
        "sku_count": 24,
        "total_available": 3456,
        "oos_skus": ["BLF-OLD-X"],
        "low_stock_skus": [
            {"sku": "BLF-WIDGET-A", "available": 8},
            {"sku": "BLF-SENSOR-C", "available": 5},
        ],
    },
    "ads": {
        "spend": 342.18,
        "sales": 8912.30,
        "roas": 26.05,
        "acos": 3.8,
        "ctr": 2.1,
    },
    "returns": {
        "qty": 12,
        "rate": 1.8,
        "top_returns": [
            {"reason": "商品与描述不符", "qty": 5},
            {"reason": "质量问题", "qty": 4},
            {"reason": "尺码不合适", "qty": 3},
        ],
    },
    "alert_rows": [
        {"sku": "BLF-WIDGET-A", "qty": 8, "badge": "告急", "badge_color": "#DC2626"},
        {"sku": "BLF-SENSOR-C", "qty": 5, "badge": "告急", "badge_color": "#DC2626"},
        {"sku": "BLF-OLD-X", "qty": 0, "badge": "缺货", "badge_color": "#7C3AED"},
    ],
}

MOCK_WEEKLY_DATA = {
    "project_name": "BLF 测试项目",
    "country": "US",
    "report_date": "2026-06-04",
    "week_number": "23",
    "date_range": "05-26 ~ 06-01",
    "prev_week_range": "05-19 ~ 05-25",
    "ai_summary": "本周销量环比增长 15.2%，销售额增长 18.7%。BLF-WIDGET-A 贡献最大增量。广告 ROAS 提升至 3.2，ACOS 降至 8.5%。建议关注 BLF-SENSOR-C 库存，仅剩 5 件。",
    "current_week": {"qty": 312, "amount": 34567.89, "avg_price": 110.80},
    "prev_week": {"qty": 271, "amount": 29123.45, "avg_price": 107.47},
    "changes": {"qty_change": 15.2, "amount_change": 18.7, "avg_price_change": 3.1},
    "daily_trend": [
        {"date": "05-26", "weekday": "Mon", "qty": 35},
        {"date": "05-27", "weekday": "Tue", "qty": 42},
        {"date": "05-28", "weekday": "Wed", "qty": 38},
        {"date": "05-29", "weekday": "Thu", "qty": 51},
        {"date": "05-30", "weekday": "Fri", "qty": 45},
        {"date": "05-31", "weekday": "Sat", "qty": 54},
        {"date": "06-01", "weekday": "Sun", "qty": 47},
    ],
    "top_skus_comparison": [
        {"sku": "BLF-WIDGET-A", "current": 89, "prev": 72, "change": 23.6, "new": False},
        {"sku": "BLF-GADGET-B", "current": 67, "prev": 58, "change": 15.5, "new": False},
        {"sku": "BLF-SENSOR-C", "current": 52, "prev": 48, "change": 8.3, "new": False},
        {"sku": "BLF-CABLE-D", "current": 48, "prev": 55, "change": -12.7, "new": False},
        {"sku": "BLF-NEW-F", "current": 31, "prev": 0, "change": 100, "new": True},
    ],
    "sku_sales_detail": [
        {"sku": "BLF-WIDGET-A", "product_name": "Premium Widget Pro Max", "qty": 89, "amount": 8912.30},
        {"sku": "BLF-GADGET-B", "product_name": "Smart Gadget Ultra", "qty": 67, "amount": 6734.50},
        {"sku": "BLF-SENSOR-C", "product_name": "Temperature Sensor V3", "qty": 52, "amount": 4156.00},
        {"sku": "BLF-CABLE-D", "product_name": "USB-C Cable 2m", "qty": 48, "amount": 2390.40},
        {"sku": "BLF-NEW-F", "product_name": "Smart Home Hub", "qty": 31, "amount": 4650.00},
    ],
    "attribution": [
        {"sku": "BLF-WIDGET-A", "contribution": 17, "pct": 41.5},
        {"sku": "BLF-GADGET-B", "contribution": 9, "pct": 22.0},
        {"sku": "BLF-NEW-F", "contribution": 31, "pct": 75.6},
        {"sku": "BLF-CABLE-D", "contribution": -7, "pct": -17.1},
    ],
    "attribution_summary": "本周增量主要来自 BLF-NEW-F 新品上市（+31 件）和 BLF-WIDGET-A 持续热销（+17 件）。BLF-CABLE-D 下滑 7 件，需关注竞品动态。",
    "ads_comparison": {
        "spend": {"current": 2345.67, "prev": 2100.00, "change": 11.7},
        "roas": {"current": 3.20, "prev": 2.80, "change": 14.3},
        "acos": {"current": 8.5, "prev": 10.2, "change": -16.7},
        "ctr": {"current": 2.3, "prev": 1.9, "change": 21.1},
    },
    "inventory_alerts": [
        {"sku": "BLF-SENSOR-C", "available_qty": 5, "level": "low"},
        {"sku": "BLF-OLD-X", "available_qty": 0, "level": "oos"},
    ],
    "returns_data": {"qty": 12, "rate": 1.8},
    "action_items": [
        {"item": "BLF-SENSOR-C 库存告急，建议立即补货 200 件", "priority": "high", "reason": "仅剩 5 件"},
        {"item": "BLF-NEW-F 新品表现优异，可加大广告投入", "priority": "medium", "reason": "首周 31 件"},
        {"item": "BLF-CABLE-D 销量下滑，排查竞品定价", "priority": "medium", "reason": "环比 -12.7%"},
    ],
    "alerts": [
        {"type": "critical", "message": "BLF-OLD-X 已断货", "action": "联系供应商确认到货时间"},
        {"type": "warning", "message": "BLF-SENSOR-C 库存不足", "action": "建议补货 200 件"},
    ],
}


def main():
    # 将 backend/ 加入 sys.path
    script_dir = os.path.dirname(os.path.abspath(__file__))
    backend_dir = os.path.dirname(script_dir)
    sys.path.insert(0, backend_dir)

    from app.services.scheduled_report.email_sender_daily import _render_daily_report_html
    from app.services.scheduled_report.email_sender_weekly import _render_weekly_report_html
    from app.services.scheduled_report.screenshot import html_to_png, _MOBILE_VIEWPORT_WIDTH, _MOBILE_SCALE_FACTOR

    # 输出目录
    out_dir = os.path.join(os.path.dirname(backend_dir), ".agent-contexts", "report_preview")
    os.makedirs(out_dir, exist_ok=True)

    print(f"截图参数: {_MOBILE_VIEWPORT_WIDTH}px x {_MOBILE_SCALE_FACTOR}x = {_MOBILE_VIEWPORT_WIDTH * _MOBILE_SCALE_FACTOR}px 物理宽度")
    print(f"输出目录: {out_dir}\n")

    # ── 日报截图 ────────────────────────────────────────────────────────────
    print("[1/2] 生成日报截图...")
    daily_html = _render_daily_report_html(MOCK_DAILY_DATA, include_summary=False, for_screenshot=True)

    # 同时保存 HTML 方便调试
    daily_html_path = os.path.join(out_dir, "daily_report.html")
    with open(daily_html_path, "w", encoding="utf-8") as f:
        f.write(daily_html)
    print(f"  HTML 已保存: {daily_html_path}")

    daily_png = html_to_png(daily_html)
    if daily_png:
        daily_png_path = os.path.join(out_dir, "daily_report_mobile.png")
        with open(daily_png_path, "wb") as f:
            f.write(daily_png)
        size_kb = len(daily_png) / 1024
        print(f"  PNG 已保存: {daily_png_path} ({size_kb:.0f} KB)")
    else:
        print("  ❌ 截图失败（Playwright 未安装？）")

    # ── 周报截图 ────────────────────────────────────────────────────────────
    print("\n[2/2] 生成周报截图...")
    weekly_html = _render_weekly_report_html(MOCK_WEEKLY_DATA, include_summary=False, for_screenshot=True)

    weekly_html_path = os.path.join(out_dir, "weekly_report.html")
    with open(weekly_html_path, "w", encoding="utf-8") as f:
        f.write(weekly_html)
    print(f"  HTML 已保存: {weekly_html_path}")

    weekly_png = html_to_png(weekly_html)
    if weekly_png:
        weekly_png_path = os.path.join(out_dir, "weekly_report_mobile.png")
        with open(weekly_png_path, "wb") as f:
            f.write(weekly_png)
        size_kb = len(weekly_png) / 1024
        print(f"  PNG 已保存: {weekly_png_path} ({size_kb:.0f} KB)")
    else:
        print("  ❌ 截图失败（Playwright 未安装？）")

    print(f"\n✅ 完成！用 Finder 打开查看:")
    print(f"   open {out_dir}")


if __name__ == "__main__":
    main()
