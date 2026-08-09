"""P9-2 无跟进提醒邮件服务（BLF-540）。

客户/线索超过 ``stale_days`` 天无跟进 → 给负责人发提醒邮件。
- 阈值与开关存 ``crm_workflow_settings``（单行表，admin 设置页读写）。
- 去重：实体表 ``stale_email_sent_at`` 标记上次提醒时间（沿用 crm_tasks.reminded_at
  先例）。判定基准 ref（客户 COALESCE(last_follow_at, created_at)；线索
  COALESCE(next_follow_at, created_at)，与 P3a 公海回收一致）：
    ref < 截止 且 (stale_email_sent_at IS NULL 或 stale_email_sent_at < ref)
  → 命中。即：从未提醒过、或上次提醒后又产生了新跟进（ref 前移）→ 每段
  「无跟进期」只提醒一次，不每天轰炸。
- 邮件按负责人聚合：一个负责人名下所有命中实体合成一封邮件。
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.crm import CrmCustomer, CrmLead, CrmWorkflowSetting

logger = logging.getLogger(__name__)

# 客户不提醒的状态（已签约是成交资产，不催）
_CUSTOMER_PROTECTED_STATUS = {"signed"}
# 线索不提醒的状态（已转化/已弃置不再流转）
_LEAD_PROTECTED_STATUS = {"converted", "discarded"}

DEFAULT_STALE_DAYS = 7
WORKFLOW_SETTING_ID = 1


# ---------- 设置读写 ----------


def get_workflow_settings(db: Session) -> CrmWorkflowSetting:
    """读取单行工作流设置；行缺失时按默认值补齐（幂等）。"""
    row = db.get(CrmWorkflowSetting, WORKFLOW_SETTING_ID)
    if row is not None:
        return row
    # 并发安全：ON CONFLICT DO NOTHING 后重查，谁插入都行
    db.execute(
        text(
            "insert into crm_workflow_settings (id, stale_days, stale_email_enabled) "
            "values (:id, :days, true) on conflict (id) do nothing"
        ),
        {"id": WORKFLOW_SETTING_ID, "days": DEFAULT_STALE_DAYS},
    )
    db.commit()
    return db.get(CrmWorkflowSetting, WORKFLOW_SETTING_ID)  # type: ignore[return-value]


def update_workflow_settings(
    db: Session,
    *,
    stale_days: int | None = None,
    stale_email_enabled: bool | None = None,
) -> CrmWorkflowSetting:
    """部分更新工作流设置；返回最新行。"""
    row = get_workflow_settings(db)
    if stale_days is not None:
        row.stale_days = stale_days
    if stale_email_enabled is not None:
        row.stale_email_enabled = stale_email_enabled
    db.commit()
    db.refresh(row)
    return row


# ---------- 扫描 ----------


def _stale_customers(db: Session, cutoff: datetime) -> list[CrmCustomer]:
    """有主且 N 天无跟进的客户（含去重条件，未按发送置位）。"""
    return (
        db.execute(
            select(CrmCustomer).where(
                CrmCustomer.is_deleted.is_(False),
                CrmCustomer.owner_id.is_not(None),
                CrmCustomer.status.not_in(_CUSTOMER_PROTECTED_STATUS),
            )
        )
        .scalars()
        .all()
    )


def _stale_leads(db: Session, cutoff: datetime) -> list[CrmLead]:
    """有主且 N 天无跟进的线索（含去重条件，未按发送置位）。"""
    return (
        db.execute(
            select(CrmLead).where(
                CrmLead.is_deleted.is_(False),
                CrmLead.owner_id.is_not(None),
                CrmLead.status.not_in(_LEAD_PROTECTED_STATUS),
            )
        )
        .scalars()
        .all()
    )


def _entity_ref(entity: CrmCustomer | CrmLead) -> datetime | None:
    """无跟进判定基准：客户=last_follow_at；线索=next_follow_at；兜底 created_at。"""
    if isinstance(entity, CrmCustomer):
        return entity.last_follow_at or entity.created_at
    return entity.next_follow_at or entity.created_at


def _should_email(
    entity: CrmCustomer | CrmLead, ref: datetime, cutoff: datetime
) -> bool:
    """去重判定：ref 超期 且（未提醒过 或 上次提醒早于本轮 ref）。"""
    if ref >= cutoff:
        return False
    sent_at = entity.stale_email_sent_at
    if sent_at is None:
        return True
    return sent_at < ref


# ---------- 邮件 ----------


def _owner_email_map(db: Session, owner_ids: set[str]) -> dict[str, tuple[str, str]]:
    """批量查 user_accounts 的 (name, email)；无邮箱的负责人不返回。返回 {owner_id: (name, email)}。"""
    if not owner_ids:
        return {}
    rows = db.execute(
        text(
            "select id::text, name, email from public.user_accounts "
            "where id = any(:ids)"
        ),
        {"ids": list(owner_ids)},
    ).all()
    return {
        str(r[0]): (r[1] or "", r[2] or "")
        for r in rows
        if r[2]  # 只有有邮箱的才进提醒集合
    }


def _render_email_html(
    owner_name: str, items: list[dict], days: int, now: datetime
) -> str:
    """按负责人聚合的提醒邮件正文（纯内联样式，兼容主流邮件客户端）。"""
    rows_html = ""
    for it in items:
        rows_html += f"""
        <tr style="border-bottom: 1px solid #E5E7EB;">
          <td style="padding: 10px 14px; white-space: nowrap;">
            <span style="display:inline-block;background:#EFF6FF;color:#2563EB;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:600;">
              {it["type_label"]}
            </span>
          </td>
          <td style="padding: 10px 14px; color: #1F2937; font-size: 14px; font-weight: 500;">{it["name"]}</td>
          <td style="padding: 10px 14px; color: #6B7280; font-size: 13px; white-space: nowrap;">{it["ref_label"]}</td>
          <td style="padding: 10px 14px; color: #DC2626; font-size: 13px; white-space: nowrap;">{it["stale_days"]} 天</td>
        </tr>"""

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, 'Segoe UI', sans-serif; background: #F3F4F6; margin: 0; padding: 24px;">
  <div style="max-width: 640px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    <div style="background: #1F2937; padding: 20px 24px;">
      <h1 style="margin: 0; color: white; font-size: 18px; font-weight: 600;">⏰ {owner_name}，有 {len(items)} 个客户/线索超过 {days} 天未跟进</h1>
      <p style="margin: 4px 0 0; color: #9CA3AF; font-size: 13px;">请及时跟进，避免流失 · {now.strftime("%Y-%m-%d %H:%M")}</p>
    </div>
    <table style="width: 100%; border-collapse: collapse;">
      <thead>
        <tr style="background: #F9FAFB;">
          <th style="padding: 8px 14px; text-align: left; font-size: 11px; color: #6B7280; text-transform: uppercase; letter-spacing: 0.05em;">类型</th>
          <th style="padding: 8px 14px; text-align: left; font-size: 11px; color: #6B7280; text-transform: uppercase; letter-spacing: 0.05em;">名称</th>
          <th style="padding: 8px 14px; text-align: left; font-size: 11px; color: #6B7280; text-transform: uppercase; letter-spacing: 0.05em;">最近跟进</th>
          <th style="padding: 8px 14px; text-align: left; font-size: 11px; color: #6B7280; text-transform: uppercase; letter-spacing: 0.05em;">未跟进</th>
        </tr>
      </thead>
      <tbody>{rows_html}</tbody>
    </table>
    <div style="padding: 16px 24px; border-top: 1px solid #E5E7EB;">
      <a href="{get_settings().frontend_url}/dashboard/crm/workbench" style="display:inline-block;background:#2563EB;color:white;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;">
        去 CRM 跟进 →
      </a>
    </div>
  </div>
</body>
</html>"""


def send_stale_email(to_email: str, subject: str, html: str) -> bool:
    """经 Resend 发送提醒邮件；未配置 key 时记 warning 并返回 False（幂等跳过）。"""
    settings = get_settings()
    if not settings.resend_api_key:
        logger.warning("RESEND_API_KEY not configured, skipping stale reminder email")
        return False

    import resend

    resend.api_key = settings.resend_api_key
    resp = resend.Emails.send(
        {
            "from": f"{settings.alert_from_name} <{settings.alert_from_email}>",
            "to": [to_email],
            "subject": subject,
            "html": html,
        }
    )
    logger.info(
        "Stale reminder email sent to %s, resend_id=%s", to_email, resp.get("id")
    )
    return True


# ---------- 主入口 ----------


def send_stale_reminder_emails(
    db: Session,
    *,
    now: datetime | None = None,
    days: int | None = None,
    email_enabled: bool | None = None,
    send_fn=send_stale_email,
) -> dict:
    """扫描并发送无跟进提醒邮件。返回统计。

    - days 缺省时从 crm_workflow_settings 读（admin 可调）。
    - email_enabled 缺省时读设置开关；False → 不发送（返回 {"disabled": True}）。
    - send_fn 可注入（测试 monkeypatch 用），默认走 Resend。
    """
    moment = now or datetime.now(timezone.utc)

    settings = get_workflow_settings(db)
    effective_days = days if days is not None else settings.stale_days
    effective_enabled = (
        email_enabled if email_enabled is not None else settings.stale_email_enabled
    )
    if not effective_enabled:
        logger.info("crm stale reminder email disabled, skip")
        return {"disabled": True, "emails_sent": 0, "customers": 0, "leads": 0}

    cutoff = moment - timedelta(days=effective_days)

    # 收集命中实体（客户 + 线索），附带 ref
    hits: list[tuple[CrmCustomer | CrmLead, datetime]] = []
    for cust in _stale_customers(db, cutoff):
        ref = _entity_ref(cust)
        if ref is not None and _should_email(cust, ref, cutoff):
            hits.append((cust, ref))
    for lead in _stale_leads(db, cutoff):
        ref = _entity_ref(lead)
        if ref is not None and _should_email(lead, ref, cutoff):
            hits.append((lead, ref))

    if not hits:
        return {
            "disabled": False,
            "emails_sent": 0,
            "customers": 0,
            "leads": 0,
            "owners_emailed": 0,
            "owners_without_email": 0,
        }

    # 按负责人聚合
    owner_entities: dict[str, list[tuple[CrmCustomer | CrmLead, datetime]]] = {}
    for entity, ref in hits:
        owner_entities.setdefault(entity.owner_id, []).append((entity, ref))  # type: ignore[arg-type]

    owner_info = _owner_email_map(db, set(owner_entities.keys()))

    emails_sent = 0
    owners_emailed = 0
    owners_without_email = 0
    marked: list[CrmCustomer | CrmLead] = []

    for owner_id, entities in owner_entities.items():
        info = owner_info.get(owner_id)
        if info is None:
            owners_without_email += 1
            continue
        owner_name, to_email = info

        items = []
        for entity, ref in entities:
            if isinstance(entity, CrmCustomer):
                items.append(
                    {
                        "type_label": "客户",
                        "name": entity.name,
                        "ref_label": ref.strftime("%Y-%m-%d"),
                        "stale_days": max((moment - ref).days, 1),
                    }
                )
            else:
                items.append(
                    {
                        "type_label": "线索",
                        "name": entity.name or entity.company or "-",
                        "ref_label": ref.strftime("%Y-%m-%d"),
                        "stale_days": max((moment - ref).days, 1),
                    }
                )

        subject = f"[CRM] 有 {len(items)} 个客户/线索超过 {effective_days} 天未跟进"
        html = _render_email_html(owner_name, items, effective_days, moment)
        try:
            ok = send_fn(to_email, subject, html)
        except Exception:  # noqa: BLE001 — 单个负责人失败不影响其他负责人
            logger.exception("Failed to send stale reminder email to %s", to_email)
            ok = False
        if ok:
            emails_sent += 1
            owners_emailed += 1
            marked.extend(e for e, _ in entities)

    # 仅对发送成功的实体置去重标记（下轮跳过；负责人无邮箱/发送失败不置位，可重试）
    if marked:
        now_utc = moment
        for entity in marked:
            entity.stale_email_sent_at = now_utc
        db.commit()

    return {
        "disabled": False,
        "emails_sent": emails_sent,
        "customers": sum(1 for e, _ in hits if isinstance(e, CrmCustomer)),
        "leads": sum(1 for e, _ in hits if isinstance(e, CrmLead)),
        "owners_emailed": owners_emailed,
        "owners_without_email": owners_without_email,
    }
