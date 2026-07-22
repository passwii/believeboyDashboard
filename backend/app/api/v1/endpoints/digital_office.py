import asyncio
import json
from datetime import datetime, UTC

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.api.deps import get_primary_db_session, protected
from app.services.digital.office_service import build_wall_snapshot

router = APIRouter(prefix="/digital-employees", tags=["digital-employees"])

TICK_SECONDS = 3.0


async def _event_stream(db):
    while True:
        now = datetime.now(UTC)
        employees = build_wall_snapshot(db, now)
        payload = json.dumps({"server_time": now.isoformat(), "employees": employees}, ensure_ascii=False)
        yield f"event: snapshot\ndata: {payload}\n\n"
        await asyncio.sleep(TICK_SECONDS)


@router.get("/office/stream")
def office_stream(db=Depends(get_primary_db_session), _=Depends(protected)):
    return StreamingResponse(_event_stream(db), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })
