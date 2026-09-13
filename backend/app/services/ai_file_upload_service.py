from io import BytesIO
from typing import TYPE_CHECKING, Any

# BLF-1036: pandas / PIL / pypdf imported lazily inside the extract_* helpers.
# This module is imported at API boot (endpoints.ai_file_upload); the
# pandas+PIL stack costs ~65MB RSS that's only needed when a file is
# actually uploaded for AI parsing.
if TYPE_CHECKING:
    import pandas as pd

from fastapi import HTTPException, UploadFile, status

from app.utils.constants import MAX_CONTENT_LENGTH, MAX_EXCEL_ROWS, MAX_EXCEL_COLS

ALLOWED_EXTENSIONS = {".csv", ".xlsx", ".xls", ".jpg", ".jpeg", ".png", ".pdf", ".txt"}
EXTENSION_SIZE_LIMITS = {
    ".csv": 5 * 1024 * 1024,
    ".xlsx": 5 * 1024 * 1024,
    ".xls": 5 * 1024 * 1024,
    ".jpg": 10 * 1024 * 1024,
    ".jpeg": 10 * 1024 * 1024,
    ".png": 10 * 1024 * 1024,
    ".pdf": 5 * 1024 * 1024,
    ".txt": 2 * 1024 * 1024,
}


def get_extension(filename: str) -> str:
    name = filename.lower()
    i = name.rfind(".")
    return name[i:] if i >= 0 else ""


def validate_file(file: UploadFile) -> None:
    ext = get_extension(file.filename or "")
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"不支持的文件类型: {ext}，"
                f"支持的类型：CSV、Excel、图片（jpg/png）、PDF、TXT"
            ),
        )

    limit = EXTENSION_SIZE_LIMITS.get(ext, 5 * 1024 * 1024)
    file.file.seek(0, 2)
    size = file.file.tell()
    file.file.seek(0)
    if size > limit:
        size_mb = size / (1024 * 1024)
        limit_mb = limit / (1024 * 1024)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"文件大小超过限制：{size_mb:.1f}MB > {limit_mb:.0f}MB",
        )


def extract_csv_content(content: bytes, filename: str) -> tuple[str, bool, str | None]:
    import pandas as pd

    try:
        df = pd.read_csv(BytesIO(content), encoding="utf-8", on_bad_lines="skip", nrows=MAX_EXCEL_ROWS)
    except Exception:
        try:
            df = pd.read_csv(BytesIO(content), encoding="latin-1", on_bad_lines="skip", nrows=MAX_EXCEL_ROWS)
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"CSV 解析失败：{e}",
            )

    truncated = df.shape[0] >= MAX_EXCEL_ROWS
    truncated_note: str | None = None
    if truncated:
        truncated_note = f"（内容已截断，仅显示前 {MAX_EXCEL_ROWS} 行）"

    lines: list[str] = [f"【文件：{filename}】"]
    lines.append(f"行数：{df.shape[0]}，列数：{min(df.shape[1], MAX_EXCEL_COLS)}")
    cols = df.columns[:MAX_EXCEL_COLS].tolist()
    lines.append("列名：" + " | ".join(str(c) for c in cols))
    lines.append("")
    lines.append("数据预览（前 20 行）：")
    lines.append(df.head(20).to_string(index=False, max_cols=MAX_EXCEL_COLS))

    return "\n".join(lines), truncated, truncated_note


def extract_excel_content(content: bytes, filename: str) -> tuple[str, bool, str | None]:
    import pandas as pd

    try:
        xl = pd.ExcelFile(BytesIO(content))
        sheets = xl.sheet_names[:3]
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Excel 解析失败：{e}",
        )

    all_lines: list[str] = [f"【文件：{filename}】"]
    all_lines.append(f"工作表：{', '.join(sheets)}")

    truncated = False
    truncated_note: str | None = None

    for sheet_name in sheets:
        try:
            df = pd.read_excel(content, sheet_name=sheet_name, engine="openpyxl", nrows=MAX_EXCEL_ROWS)
        except Exception:
            try:
                df = pd.read_excel(content, sheet_name=sheet_name, engine="xlrd", nrows=MAX_EXCEL_ROWS)
            except Exception:
                df = pd.DataFrame()

        sheet_rows = df.shape[0]
        if sheet_rows >= MAX_EXCEL_ROWS:
            truncated = True

        all_lines.append(f"\n=== 工作表：{sheet_name} ===")
        all_lines.append(f"行数：{sheet_rows}，列数：{min(df.shape[1], MAX_EXCEL_COLS)}")
        cols = df.columns[:MAX_EXCEL_COLS].tolist()
        all_lines.append("列名：" + " | ".join(str(c) for c in cols))
        all_lines.append("数据预览（前 10 行）：")
        all_lines.append(df.head(10).to_string(index=False, max_cols=MAX_EXCEL_COLS))

    if truncated:
        truncated_note = f"（部分工作表内容已截断，仅显示前 {MAX_EXCEL_ROWS} 行）"

    content_str = "\n".join(all_lines)
    if len(content_str) > MAX_CONTENT_LENGTH:
        truncated = True
        truncated_note = f"（内容已截断，超过 {MAX_CONTENT_LENGTH} 字符限制）"
        content_str = content_str[:MAX_CONTENT_LENGTH] + "\n...（内容截断）"

    return content_str, truncated, truncated_note


def extract_image_content(content: bytes, filename: str) -> tuple[str, bool, str | None]:
    from PIL import Image

    try:
        img = Image.open(BytesIO(content))
        w, h = img.size
        mode = img.mode
        alpha_note = "（含透明通道）" if mode in ("RGBA", "LA", "P") else ""
        text = (
            f"【图片文件：{filename}】\n"
            f"尺寸：{w}x{h}，颜色模式：{mode}{alpha_note}\n"
            f"请描述这张图片的内容。"
        )
        return text, False, None
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"图片解析失败：{e}",
        )


def extract_pdf_content(content: bytes, filename: str) -> tuple[str, bool, str | None]:
    from pypdf import PdfReader

    try:
        reader = PdfReader(BytesIO(content))
        total_pages = len(reader.pages)
        pages_to_extract = min(total_pages, 20)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"PDF 解析失败：{e}",
        )

    truncated = total_pages > pages_to_extract
    truncated_note: str | None = None
    if truncated:
        truncated_note = f"（内容已截断，仅提取前 {pages_to_extract} 页，共 {total_pages} 页）"

    all_lines: list[str] = [f"【PDF 文件：{filename}】"]
    all_lines.append(f"总页数：{total_pages}，提取页数：{pages_to_extract}")

    for i, page in enumerate(reader.pages[:pages_to_extract]):
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        all_lines.append(f"\n--- 第 {i+1} 页 ---")
        all_lines.append(text[:3000] if text else "（无文本内容）")

    content_str = "\n".join(all_lines)
    if len(content_str) > MAX_CONTENT_LENGTH:
        truncated = True
        truncated_note = f"（内容已截断，超过 {MAX_CONTENT_LENGTH} 字符限制）"
        content_str = content_str[:MAX_CONTENT_LENGTH] + "\n...（内容截断）"

    return content_str, truncated, truncated_note


def extract_txt_content(content: bytes, filename: str) -> tuple[str, bool, str | None]:
    try:
        text = content.decode("utf-8")
    except Exception:
        try:
            text = content.decode("gbk")
        except Exception:
            text = content.decode("latin-1", errors="replace")

    truncated = False
    truncated_note: str | None = None
    if len(text) > MAX_CONTENT_LENGTH:
        truncated = True
        truncated_note = f"（内容已截断，仅显示前 {MAX_CONTENT_LENGTH} 字符）"
        text = text[:MAX_CONTENT_LENGTH]

    return f"【文件：{filename}】\n{text}", truncated, truncated_note


def extract_file_content(file: UploadFile) -> dict[str, Any]:
    validate_file(file)

    content = file.file.read()
    ext = get_extension(file.filename or "")
    filename = file.filename or "未命名文件"

    if ext == ".csv":
        content_str, truncated, note = extract_csv_content(content, filename)
    elif ext in (".xlsx", ".xls"):
        content_str, truncated, note = extract_excel_content(content, filename)
    elif ext in (".jpg", ".jpeg", ".png"):
        content_str, truncated, note = extract_image_content(content, filename)
    elif ext == ".pdf":
        content_str, truncated, note = extract_pdf_content(content, filename)
    elif ext == ".txt":
        content_str, truncated, note = extract_txt_content(content, filename)
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"不支持的文件类型: {ext}",
        )

    file_type_map = {
        ".csv": "csv",
        ".xlsx": "excel",
        ".xls": "excel",
        ".jpg": "image",
        ".jpeg": "image",
        ".png": "image",
        ".pdf": "pdf",
        ".txt": "text",
    }

    return {
        "file_name": filename,
        "file_type": file_type_map.get(ext, "unknown"),
        "content": content_str,
        "truncated": truncated,
        "truncated_note": note,
    }
