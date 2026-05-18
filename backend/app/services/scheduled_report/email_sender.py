"""Scheduled report email sender using Resend."""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

import resend

from app.core.config import get_settings

logger = logging.getLogger(__name__)


def _render_daily_report_html(report_data: dict[str, Any]) -> str:
    """构建每日报告 HTML 邮件。"""
    sales = report_data.get("sales", {})
    inventory = report_data.get("inventory", {})
    ads = report_data.get("ads", {})
    ai_summary = report_data.get("ai_summary", "暂无 AI 摘要")

    sales_change = sales.get("sales_change_pct", 0)
    change_color = "#22C55E" if sales_change >= 0 else "#EF4444"
    change_icon = "↑" if sales_change >= 0 else "↓"

    return f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>BelieveBoy 每日运营报告</title></head>
<body style="font-family: -apple-system, 'Segoe UI', sans-serif; background: #F3F4F6; margin: 0; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #1F2937 0%, #374151 100%); padding: 24px;">
      <h1 style="margin: 0; color: white; font-size: 20px; font-weight: 600;">📊 BelieveBoy 每日运营报告</h1>
      <p style="margin: 4px 0 0; color: #9CA3AF; font-size: 13px;">{report_data.get('report_date', date.today().isoformat())} · {report_data.get('country', 'US')}</p>
    </div>
    <div style="margin: 16px; padding: 16px; background: #EFF6FF; border-radius: 8px; border-left: 4px solid #3B82F6;">
      <p style="margin: 0 0 8px; font-size: 12px; font-weight: 600; color: #1D4ED8; text-transform: uppercase;">🔍 AI 摘要</p>
      <p style="margin: 0; font-size: 14px; color: #1E3A5F; line-height: 1.6;">{ai_summary}</p>
    </div>
    <div style="padding: 0 16px 16px; display: grid; gap: 12px;">
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px;">
        <h3 style="margin: 0 0 12px; font-size: 14px; font-weight: 600; color: #374151;">📈 销售概览</h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div><p style="margin: 0; font-size: 11px; color: #6B7280;">今日销量</p><p style="margin: 2px 0 0; font-size: 20px; font-weight: 700; color: #111827;">{sales.get('today_order_qty', 0):,}</p></div>
          <div><p style="margin: 0; font-size: 11px; color: #6B7280;">今日销售额</p><p style="margin: 2px 0 0; font-size: 20px; font-weight: 700; color: #111827;">¥{sales.get('today_sales_amount', 0):,.2f}</p></div>
          <div><p style="margin: 0; font-size: 11px; color: #6B7280;">环比变化</p><p style="margin: 2px 0 0; font-size: 16px; font-weight: 600; color: {change_color};">{change_icon} {abs(sales_change):.1f}%</p></div>
        </div>
      </div>
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px;">
        <h3 style="margin: 0 0 12px; font-size: 14px; font-weight: 600; color: #374151;">📦 库存状态</h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;">
          <div><p style="margin: 0; font-size: 11px; color: #6B7280;">SKU 总数</p><p style="margin: 2px 0 0; font-size: 18px; font-weight: 700; color: #111827;">{inventory.get('sku_count', 0):,}</p></div>
          <div><p style="margin: 0; font-size: 11px; color: #6B7280;">可用库存</p><p style="margin: 2px 0 0; font-size: 18px; font-weight: 700; color: #111827;">{inventory.get('available_qty', 0):,}</p></div>
          <div><p style="margin: 0; font-size: 11px; color: #6B7280;">缺货 SKU</p><p style="margin: 2px 0 0; font-size: 18px; font-weight: 700; color: {'#EF4444' if inventory.get('out_of_stock_count', 0) > 0 else '#111827'};">{inventory.get('out_of_stock_count', 0)}</p></div>
        </div>
      </div>
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px;">
        <h3 style="margin: 0 0 12px; font-size: 14px; font-weight: 600; color: #374151;">💰 广告数据</h3>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; text-align: center;">
          <div><p style="margin: 0; font-size: 10px; color: #6B7280;">花费</p><p style="margin: 2px 0 0; font-size: 14px; font-weight: 600;">¥{ads.get('period_spend', 0):,.2f}</p></div>
          <div><p style="margin: 0; font-size: 10px; color: #6B7280;">ROAS</p><p style="margin: 2px 0 0; font-size: 14px; font-weight: 600;">{ads.get('period_roas', 0):.2f}</p></div>
          <div><p style="margin: 0; font-size: 10px; color: #6B7280;">ACOS</p><p style="margin: 2px 0 0; font-size: 14px; font-weight: 600;">{ads.get('period_acos', 0):.1f}%</p></div>
          <div><p style="margin: 0; font-size: 10px; color: #6B7280;">CTR</p><p style="margin: 2px 0 0; font-size: 14px; font-weight: 600;">{ads.get('period_ctr', 0):.2f}%</p></div>
        </div>
      </div>
    </div>
    <div style="padding: 16px; border-top: 1px solid #E5E7EB; text-align: center;">
      <a href="{get_settings().frontend_url}/dashboard" style="display:inline-block;background:#2563EB;color:white;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:13px;font-weight:500;">查看完整报告 →</a>
      <p style="margin: 12px 0 0; font-size: 11px; color: #9CA3AF;">BelieveBoy Dashboard · 定时报告推送</p>
    </div>
  </div>
</body>
</html>"""


def _render_weekly_report_html(report_data: dict[str, Any]) -> str:
    """构建每周报告 HTML 邮件。"""
    ai_summary = report_data.get("ai_summary", "暂无 AI 摘要")
    week_sales = report_data.get("week_sales", {})
    week_ads = report_data.get("week_ads", {})
    top_skus = report_data.get("top_skus", [])
    inventory_alerts = report_data.get("inventory_alerts", [])

    sku_rows = "".join(f"""<tr style="border-bottom: 1px solid #F3F4F6;">
      <td style="padding: 8px; font-size: 13px; color: #374151;">{sku.get('sku', '')}</td>
      <td style="padding: 8px; font-size: 13px; text-align: right; font-weight: 600;">{sku.get('quantity', 0):,}</td>
    </tr>""" for sku in top_skus[:5])

    alert_rows = "".join(f"""<tr style="border-bottom: 1px solid #FEF2F2;">
      <td style="padding: 8px;"><span style="display:inline-block;background:#FEE2E2;color:#DC2626;border-radius:4px;padding:2px 6px;font-size:11px;">告急</span></td>
      <td style="padding: 8px; font-size: 13px; color: #374151;">{alert.get('sku', '')}</td>
      <td style="padding: 8px; font-size: 12px; color: #DC2626;">库存 {alert.get('available_qty', 0)} 件</td>
    </tr>""" for alert in inventory_alerts[:3])

    alert_section = f"""<div style="padding: 0 16px 16px;">
      <h3 style="margin: 0 0 8px; font-size: 14px; font-weight: 600; color: #374151;">⚠️ 库存预警</h3>
      <table style="width: 100%; border-collapse: collapse; border: 1px solid #FEE2E2; border-radius: 8px; overflow: hidden;">
        <thead><tr style="background: #FEF2F2;"><th style="padding: 8px 16px; font-size: 11px; color: #991B1B;">状态</th><th style="padding: 8px 16px; font-size: 11px; color: #991B1B;">SKU</th><th style="padding: 8px 16px; font-size: 11px; color: #991B1B;">可用库存</th></tr></thead>
        <tbody>{alert_rows}</tbody>
      </table>
    </div>""" if alert_rows else ""

    return f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, 'Segoe UI', sans-serif; background: #F3F4F6; margin: 0; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #1F2937 0%, #374151 100%); padding: 24px;">
      <h1 style="margin: 0; color: white; font-size: 20px; font-weight: 600;">📊 BelieveBoy 每周运营报告</h1>
      <p style="margin: 4px 0 0; color: #9CA3AF; font-size: 13px;">{report_data.get('report_date', '')} · 第 {report_data.get('week_number', '')} 周</p>
    </div>
    <div style="margin: 16px; padding: 16px; background: #EFF6FF; border-radius: 8px; border-left: 4px solid #3B82F6;">
      <p style="margin: 0 0 8px; font-size: 12px; font-weight: 600; color: #1D4ED8; text-transform: uppercase;">🔍 AI 周报</p>
      <p style="margin: 0; font-size: 14px; color: #1E3A5F; line-height: 1.6;">{ai_summary}</p>
    </div>
    <div style="padding: 0 16px 16px;">
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px; margin-bottom: 12px;">
        <h3 style="margin: 0 0 12px; font-size: 14px; font-weight: 600;">📈 本周销售</h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
          <div><p style="margin: 0; font-size: 11px; color: #6B7280;">本周总销量</p><p style="margin: 2px 0 0; font-size: 24px; font-weight: 700; color: #111827;">{week_sales.get('total_qty', 0):,}</p></div>
          <div><p style="margin: 0; font-size: 11px; color: #6B7280;">本周总销售额</p><p style="margin: 2px 0 0; font-size: 24px; font-weight: 700; color: #111827;">¥{week_sales.get('total_amount', 0):,.2f}</p></div>
        </div>
      </div>
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px;">
        <h3 style="margin: 0 0 12px; font-size: 14px; font-weight: 600;">💰 本周广告</h3>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; text-align: center;">
          <div><p style="margin:0;font-size:11px;color:#6B7280;">花费</p><p style="margin:2px 0 0;font-size:14px;font-weight:600;">¥{week_ads.get('total_spend', 0):,.0f}</p></div>
          <div><p style="margin:0;font-size:11px;color:#6B7280;">广告销售</p><p style="margin:2px 0 0;font-size:14px;font-weight:600;">¥{week_ads.get('total_sales', 0):,.0f}</p></div>
          <div><p style="margin:0;font-size:11px;color:#6B7280;">ROAS</p><p style="margin:2px 0 0;font-size:14px;font-weight:600;">{week_ads.get('avg_roas', 0):.2f}</p></div>
          <div><p style="margin:0;font-size:11px;color:#6B7280;">ACOS</p><p style="margin:2px 0 0;font-size:14px;font-weight:600;">{week_ads.get('avg_acos', 0):.1f}%</p></div>
        </div>
      </div>
    </div>
    <div style="padding: 0 16px 16px;">
      <table style="width: 100%; border-collapse: collapse; border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
        <thead><tr style="background: #F9FAFB;"><th style="padding: 10px 16px; font-size: 12px; color: #6B7280; text-align: left;">TOP SKU</th><th style="padding: 10px 16px; font-size: 12px; color: #6B7280; text-align: right;">销量</th></tr></thead>
        <tbody>{sku_rows}</tbody>
      </table>
    </div>
    {alert_section}
    <div style="padding: 16px; border-top: 1px solid #E5E7EB; text-align: center;">
      <a href="{get_settings().frontend_url}/dashboard" style="display:inline-block;background:#2563EB;color:white;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:13px;font-weight:500;">查看完整报告 →</a>
    </div>
  </div>
</body>
</html>"""


def _render_monthly_report_html(report_data: dict[str, Any]) -> str:
    """构建每月报告 HTML 邮件。"""
    ai_summary = report_data.get("ai_summary", "暂无 AI 摘要")
    financial = report_data.get("financial_summary", {})
    projects = report_data.get("project_breakdown", [])
    commission = report_data.get("commission_summary", {})

    project_rows = "".join(f"""<tr style="border-bottom: 1px solid #F3F4F6;">
      <td style="padding: 10px 16px; font-size: 13px; color: #374151;">{p.get('name', '')}</td>
      <td style="padding: 10px 16px; font-size: 13px; text-align: right; font-weight: 600;">¥{p.get('revenue', 0):,.2f}</td>
      <td style="padding: 10px 16px; font-size: 13px; text-align: right;">{p.get('profit_margin', 0):.1f}%</td>
    </tr>""" for p in projects)

    project_section = f"""<div style="padding: 0 16px 16px;">
      <h3 style="margin: 0 0 8px; font-size: 14px; font-weight: 600;">📁 各项目表现</h3>
      <table style="width: 100%; border-collapse: collapse; border: 1px solid #E5E7EB; border-radius: 8px; overflow: hidden;">
        <thead><tr style="background: #F9FAFB;"><th style="padding: 10px 16px; font-size: 12px; color: #6B7280; text-align: left;">项目</th><th style="padding: 10px 16px; font-size: 12px; color: #6B7280; text-align: right;">收入</th><th style="padding: 10px 16px; font-size: 12px; color: #6B7280; text-align: right;">利润率</th></tr></thead>
        <tbody>{project_rows}</tbody>
      </table>
    </div>""" if project_rows else ""

    return f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, 'Segoe UI', sans-serif; background: #F3F4F6; margin: 0; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <div style="background: linear-gradient(135deg, #1F2937 0%, #374151 100%); padding: 24px;">
      <h1 style="margin: 0; color: white; font-size: 20px; font-weight: 600;">📊 BelieveBoy {report_data.get('report_month', '')} 月度报告</h1>
      <p style="margin: 4px 0 0; color: #9CA3AF; font-size: 13px;">月度财务汇总 · {report_data.get('country', 'US')}</p>
    </div>
    <div style="margin: 16px; padding: 16px; background: #EFF6FF; border-radius: 8px; border-left: 4px solid #3B82F6;">
      <p style="margin: 0 0 8px; font-size: 12px; font-weight: 600; color: #1D4ED8; text-transform: uppercase;">🔍 AI 月报</p>
      <p style="margin: 0; font-size: 14px; color: #1E3A5F; line-height: 1.6;">{ai_summary}</p>
    </div>
    <div style="padding: 0 16px 16px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;">
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px; text-align: center;"><p style="margin: 0; font-size: 11px; color: #6B7280;">总收入</p><p style="margin: 4px 0 0; font-size: 18px; font-weight: 700; color: #111827;">¥{financial.get('total_revenue', 0):,.2f}</p></div>
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px; text-align: center;"><p style="margin: 0; font-size: 11px; color: #6B7280;">总成本</p><p style="margin: 4px 0 0; font-size: 18px; font-weight: 700; color: #111827;">¥{financial.get('total_cost', 0):,.2f}</p></div>
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px; text-align: center;"><p style="margin: 0; font-size: 11px; color: #6B7280;">净利润</p><p style="margin: 4px 0 0; font-size: 18px; font-weight: 700; color: #22C55E;">¥{financial.get('net_profit', 0):,.2f}</p></div>
      <div style="padding: 16px; border: 1px solid #E5E7EB; border-radius: 8px; text-align: center;"><p style="margin: 0; font-size: 11px; color: #6B7280;">佣金合计</p><p style="margin: 4px 0 0; font-size: 18px; font-weight: 700; color: #111827;">¥{commission.get('total', 0):,.2f}</p></div>
    </div>
    {project_section}
    <div style="padding: 16px; border-top: 1px solid #E5E7EB; text-align: center;">
      <a href="{get_settings().frontend_url}/dashboard" style="display:inline-block;background:#2563EB;color:white;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:13px;font-weight:500;">查看完整报告 →</a>
    </div>
  </div>
</body>
</html>"""


def send_scheduled_report_email(
    to_email: str,
    frequency: str,
    report_data: dict[str, Any],
) -> tuple[bool, str | None]:
    """发送定时报告邮件。返回 (success, resend_id)。"""
    settings = get_settings()
    if not settings.resend_api_key:
        logger.warning("RESEND_API_KEY not configured, skipping report email")
        return False, "RESEND_API_KEY not configured"

    resend.api_key = settings.resend_api_key

    if frequency == "daily":
        html = _render_daily_report_html(report_data)
        subject = f"📊 BelieveBoy 每日运营报告 · {report_data.get('report_date', '')}"
    elif frequency == "weekly":
        html = _render_weekly_report_html(report_data)
        subject = f"📊 BelieveBoy 每周运营报告 · {report_data.get('report_date', '')}"
    else:
        html = _render_monthly_report_html(report_data)
        subject = f"📊 BelieveBoy {report_data.get('report_month', '')} 月度报告"

    try:
        resp = resend.Emails.send({
            "from": f"{settings.alert_from_name} <{settings.alert_from_email}>",
            "to": [to_email],
            "subject": subject,
            "html": html,
        })
        resend_id: str | None = resp.get("id")
        logger.info(f"Scheduled report email sent to {to_email}, frequency={frequency}, resend_id={resend_id}")
        return True, resend_id
    except Exception as e:
        logger.error(f"Failed to send scheduled report email to {to_email}: {e}")
        return False, str(e)


def send_test_report_email(to_email: str, frequency: str) -> tuple[bool, str | None]:
    """发送测试报告邮件。"""
    report_date = date.today().isoformat()
    report_data = {
        "report_date": report_date,
        "report_month": report_date[:7],
        "country": "US",
        "ai_summary": "这是一封测试邮件，用于验证报告推送配置是否正确。如果收到此邮件，说明配置成功。",
        "sales": {"today_order_qty": 1234, "today_sales_amount": 45678.90, "sales_change_pct": 8.5},
        "inventory": {"sku_count": 456, "available_qty": 7890, "out_of_stock_count": 3},
        "ads": {"period_spend": 234.56, "period_roas": 3.2, "period_acos": 18.5, "period_ctr": 2.1},
        "week_sales": {"total_qty": 8765, "total_amount": 123456.78},
        "week_ads": {"total_spend": 1234.56, "total_sales": 5678.90, "avg_roas": 4.6, "avg_acos": 21.7},
        "top_skus": [
            {"sku": "SKU-A001", "quantity": 234},
            {"sku": "SKU-B002", "quantity": 189},
            {"sku": "SKU-C003", "quantity": 156},
        ],
        "inventory_alerts": [
            {"sku": "SKU-X100", "available_qty": 5},
            {"sku": "SKU-Y200", "available_qty": 3},
        ],
        "financial_summary": {"total_revenue": 1234567.89, "total_cost": 876543.21, "net_profit": 358024.68},
        "project_breakdown": [
            {"name": "项目 A", "revenue": 567890.12, "profit_margin": 28.5},
            {"name": "项目 B", "revenue": 456789.34, "profit_margin": 32.1},
        ],
        "commission_summary": {"total": 67890.12},
    }
    return send_scheduled_report_email(to_email, frequency, report_data)
