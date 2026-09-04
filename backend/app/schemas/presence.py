from pydantic import BaseModel, Field


class PresenceHeartbeatRequest(BaseModel):
    current_path: str = Field(min_length=1, max_length=255)
    current_page_title: str = Field(min_length=1, max_length=255)


class PresenceUserItem(BaseModel):
    user_id: str
    display_name: str
    email: str | None = None
    avatar_url: str | None = None
    current_path: str
    current_page_title: str
    last_seen_at: str
    is_current_user: bool = False


class PresenceResponse(BaseModel):
    server_time: str
    items: list[PresenceUserItem]
