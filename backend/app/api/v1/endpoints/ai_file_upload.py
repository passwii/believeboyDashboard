from fastapi import APIRouter, Depends, UploadFile, File
from fastapi import status

from app.api.deps import protected
from app.schemas.ai_file_upload import AIFileUploadResponse
from app.services import ai_file_upload_service


router = APIRouter(prefix="/ai", tags=["ai"], dependencies=[Depends(protected)])


@router.post("/upload", response_model=AIFileUploadResponse)
def upload_file_for_ai(file: UploadFile = File(...)) -> AIFileUploadResponse:
    result = ai_file_upload_service.extract_file_content(file)
    return AIFileUploadResponse(**result)
