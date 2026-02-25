from fastapi import APIRouter, Depends, File, Form, UploadFile

from app.api.deps import protected
from app.core.config import Settings, get_settings
from app.schemas.upload import UploadResponse
from app.services.upload_service import save_upload_file

router = APIRouter(dependencies=[Depends(protected)])


@router.post('/uploads', response_model=UploadResponse)
def upload_file(
    file: UploadFile = File(...),
    project_name: str = Form(...),
    file_type: str = Form(...),
    settings: Settings = Depends(get_settings),
) -> UploadResponse:
    payload = save_upload_file(file=file, settings=settings, project_name=project_name, file_type=file_type)
    return UploadResponse(**payload)
