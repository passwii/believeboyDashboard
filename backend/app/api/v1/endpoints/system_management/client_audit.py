"""
客户端审计端点。
"""
from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.api.deps import get_db_session, get_request_operator, protected

from app.schemas.system_management.client_audit import OperationAuditClientActionRequest

from app.services.audit_log_service import append_operation_audit_log


router = APIRouter(prefix="/operation-audit-logs", tags=["客户端审计"])


@router.post("/client-actions")
def create_client_operation_audit_log(
    payload: OperationAuditClientActionRequest,
    request: Request,
    db: Session = Depends(get_db_session),
    operator: str | None = Depends(get_request_operator),
) -> dict[str, bool]:
    append_operation_audit_log(
        db,
        action=payload.action,
        target_type=payload.target_type,
        target_id=payload.target_id,
        operator=operator,
        result=payload.result,
        after=payload.after,
        error_message=payload.error_message,
        request=request,
    )
    db.commit()
    return {"ok": True}