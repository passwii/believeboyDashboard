from pydantic import BaseModel, Field


class AIFileUploadResponse(BaseModel):
    file_name: str
    file_type: str
    content: str = Field(max_length=50000)
    truncated: bool = False
    truncated_note: str | None = None
