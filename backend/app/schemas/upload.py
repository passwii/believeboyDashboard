from pydantic import BaseModel


class UploadResponse(BaseModel):
    file_id: str
    file_path: str
    filename: str
    original_filename: str
    size: int
