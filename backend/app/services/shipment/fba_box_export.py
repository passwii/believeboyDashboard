"""FBA 箱单明细 XLSX 导出，与 Dashboard 现有工作簿保持一致。"""

from __future__ import annotations

import io
import logging
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from urllib.parse import urlsplit

from app.core.config import get_settings
from app.services.shipment.validation import normalize_shipment_no_filters

logger = logging.getLogger(__name__)

XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
SHEET_NAME = "FBA箱单明细"
MAX_SHIPMENT_NOS = 100
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
MAX_IMAGE_DIMENSION = 2048
IMAGE_TIMEOUT_SECONDS = 3
IMAGE_WORKERS = 6

_HEADERS = (
    "货件编号",
    "追踪 ID",
    "仓库 ID",
    "SKU",
    "品名",
    "产品图片",
    "ASIN",
    "FNSKU",
    "外箱长(cm)",
    "外箱宽(cm)",
    "外箱高(cm)",
    "外箱重量(kg)",
    "装箱率",
    "总箱数",
    "标签号段",
    "总数量",
    "总体积(m³)",
    "总重量(kg)",
)
_COLUMN_WIDTHS = (20, 18, 16, 12, 28, 16, 20, 20, 13, 13, 13, 14, 12, 10, 14, 10, 14, 14)
_UNSAFE_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]')


@dataclass(frozen=True)
class FbaBoxDetailsArtifact:
    filename: str
    content: bytes
    content_type: str = XLSX_CONTENT_TYPE


def normalize_export_shipment_nos(values: list[str] | None) -> list[str]:
    """清理并去重货件编号；拒绝空值和超过 100 个不同编号的导出请求。"""
    normalized = normalize_shipment_no_filters(values)
    if not normalized:
        raise ValueError("shipment_no 至少需要一个有效货件编号")
    if len(values or []) > MAX_SHIPMENT_NOS or len(normalized) > MAX_SHIPMENT_NOS:
        raise ValueError(f"shipment_no 最多支持 {MAX_SHIPMENT_NOS} 个货件")
    return normalized


def _safe_filename_segment(value: str, *, fallback: str) -> str:
    safe = _UNSAFE_FILENAME_CHARS.sub("-", value or "")
    safe = re.sub(r"\s+", " ", safe).strip(" .-")
    return safe or fallback


def _build_filename(project_name: str, shipment_nos: list[str]) -> str:
    safe_project = _safe_filename_segment(project_name, fallback="项目")
    safe_nos = [_safe_filename_segment(no, fallback="货件") for no in shipment_nos]
    if len(safe_nos) == 1:
        shipment_segment = safe_nos[0]
    else:
        shipment_segment = "_".join(safe_nos[:3])
        if len(safe_nos) > 3:
            shipment_segment += f"_等{len(safe_nos)}个货件"
    # 避免超长文件名（尤其是不同平台的下载限制）。
    shipment_segment = shipment_segment[:100].rstrip(" .-") or "货件"
    return f"{safe_project[:80]}-FBA箱单明细-{shipment_segment}.xlsx"


def _allowed_image_origins() -> set[tuple[str, str, int | None]]:
    settings = get_settings()
    origins: set[tuple[str, str, int | None]] = set()
    for configured in (settings.r2_public_url, settings.r2_endpoint_url):
        if not configured:
            continue
        parsed = urlsplit(configured)
        if parsed.scheme.lower() != "https" or not parsed.hostname:
            continue
        try:
            port = parsed.port
        except ValueError:
            continue
        origins.add((parsed.scheme.lower(), parsed.hostname.lower(), port))
    return origins


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """不跟随图片 URL 的重定向，防止公开资源 URL 被用于 SSRF 跳转。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _fetch_product_image(url: str) -> bytes | None:
    """安全地下载并标准化单张产品图；所有图片错误都降级为空图。"""
    try:
        parsed = urlsplit(url)
        if (
            parsed.scheme.lower() != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.fragment
            or (parsed.scheme.lower(), parsed.hostname.lower(), parsed.port)
            not in _allowed_image_origins()
        ):
            return None

        request = urllib.request.Request(
            url,
            headers={"Accept": "image/png,image/jpeg,image/gif", "User-Agent": "BelieveBoyDashboard/1.0"},
        )
        opener = urllib.request.build_opener(_NoRedirectHandler())
        with opener.open(request, timeout=IMAGE_TIMEOUT_SECONDS) as response:
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > MAX_IMAGE_BYTES:
                return None
            source = response.read(MAX_IMAGE_BYTES + 1)
        if not source or len(source) > MAX_IMAGE_BYTES:
            return None

        from PIL import Image

        with Image.open(io.BytesIO(source)) as image:
            if image.width > MAX_IMAGE_DIMENSION or image.height > MAX_IMAGE_DIMENSION:
                return None
            image.load()
            normalized = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            normalized.thumbnail((100, 100))
            output = io.BytesIO()
            normalized.save(output, format="PNG", optimize=True)
            return output.getvalue()
    except Exception as exc:  # noqa: BLE001 - 图片不可用不得影响整份导出
        logger.info("FBA 箱单导出跳过不可用产品图 (%s)", type(exc).__name__)
        return None


def _format_decimal(value: float, digits: int) -> str:
    formatted = f"{value:,.{digits}f}"
    return formatted.rstrip("0").rstrip(".") if "." in formatted else formatted


def _label_ranges(items: list[dict[str, object]]) -> list[str]:
    ranges: list[str] = []
    counters: dict[str, int] = {}
    for item in items:
        count = int(item.get("carton_count") or 0)
        shipment_no = str(item["shipment_no"])
        if count <= 0:
            ranges.append("-")
            continue
        start = counters.get(shipment_no, 1)
        end = start + count - 1
        counters[shipment_no] = end + 1
        prefix = str(item.get("fba_label_prefix") or shipment_no)
        ranges.append(f"{prefix}U000{start:03d}-{end:03d}")
    return ranges


def _merge_adjacent_groups(worksheet, values: list[tuple], column: int, start_row: int) -> None:
    from openpyxl.styles import Alignment, Font

    if not values:
        return
    start = 0
    for index in range(1, len(values) + 1):
        if index < len(values) and values[index] == values[start]:
            continue
        if index - start > 1:
            first_row = start_row + start
            last_row = start_row + index - 1
            worksheet.merge_cells(start_row=first_row, start_column=column, end_row=last_row, end_column=column)
            anchor = worksheet.cell(first_row, column)
            anchor.font = Font(name="Microsoft YaHei", size=9, bold=True, color="FF0F172A")
            anchor.alignment = Alignment(vertical="center", horizontal="center")
        start = index


def _style_group_banding(worksheet, items: list[dict[str, object]], start_row: int) -> None:
    from openpyxl.styles import Border, PatternFill, Side

    groups: list[tuple[int, int]] = []
    group_start = 0
    for index in range(1, len(items)):
        if items[index].get("shipment_no") != items[group_start].get("shipment_no"):
            groups.append((group_start, index - 1))
            group_start = index
    groups.append((group_start, len(items) - 1))

    for group_index, (first, last) in enumerate(groups):
        multi = last > first
        previous_multi = group_index > 0 and groups[group_index - 1][1] > groups[group_index - 1][0]
        next_multi = group_index + 1 < len(groups) and groups[group_index + 1][1] > groups[group_index + 1][0]
        fill = "FFFFFFFF" if group_index % 2 == 0 else "FFF8FAFC"
        for offset in range(first, last + 1):
            row = start_row + offset
            for column in range(1, len(_HEADERS) + 1):
                cell = worksheet.cell(row, column)
                cell.fill = PatternFill(fill_type="solid", fgColor=fill)
                cell.border = Border(
                    top=Side(style="medium" if offset == first and (multi or previous_multi) else "thin", color="FF94A3B8"),
                    bottom=Side(style="medium" if offset == last and (multi or next_multi) else "thin", color="FF94A3B8"),
                    left=Side(style="medium" if column == 1 else "thin", color="FFCBD5E1"),
                    right=Side(style="medium" if column == len(_HEADERS) else "thin", color="FFCBD5E1"),
                )


def _safe_image_origin(url: str, origins: set[tuple[str, str, int | None]]) -> bool:
    try:
        parsed = urlsplit(url)
        return bool(
            parsed.scheme.lower() == "https"
            and parsed.hostname
            and not parsed.username
            and not parsed.password
            and not parsed.fragment
            and (parsed.scheme.lower(), parsed.hostname.lower(), parsed.port) in origins
        )
    except ValueError:
        return False


def _attach_images(worksheet, items: list[dict[str, object]], start_row: int) -> None:
    from openpyxl.drawing.image import Image as XLImage

    urls = list(dict.fromkeys(
        str(item.get("product_image_r2_url"))
        for item in items
        if item.get("product_image_r2_url")
    ))
    allowed_origins = _allowed_image_origins()
    urls = [url for url in urls if _safe_image_origin(url, allowed_origins)]
    if not urls:
        return

    # 以小批并发抓取，限制网络资源峰值；单张失败只跳过该图。
    image_data: dict[str, bytes] = {}
    for offset in range(0, len(urls), IMAGE_WORKERS):
        batch = urls[offset : offset + IMAGE_WORKERS]
        with ThreadPoolExecutor(max_workers=min(IMAGE_WORKERS, len(batch))) as executor:
            for url, data in zip(batch, executor.map(_fetch_product_image, batch), strict=True):
                if data and sum(map(len, image_data.values())) + len(data) <= MAX_TOTAL_IMAGE_BYTES:
                    image_data[url] = data

    for index, item in enumerate(items):
        url = str(item.get("product_image_r2_url") or "")
        if url not in image_data:
            continue
        try:
            image = XLImage(io.BytesIO(image_data[url]))
            image.width = 100
            image.height = 100
            worksheet.add_image(image, f"F{start_row + index}")
        except Exception as exc:  # noqa: BLE001 - 图片失败不影响导出
            logger.info("FBA 箱单导出跳过无法嵌入的产品图 (%s)", type(exc).__name__)


def build_fba_box_details_export(
    *,
    project_name: str,
    shipment_nos: list[str],
    items: list[dict[str, object]],
) -> FbaBoxDetailsArtifact:
    """将 shipment_service 的权威箱单行渲染为 Dashboard 同版式 XLSX。"""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    workbook = Workbook()
    workbook.creator = "Codex"
    worksheet = workbook.active
    worksheet.title = SHEET_NAME
    worksheet.freeze_panes = "A2"
    worksheet.sheet_view.showGridLines = False

    for column, width in enumerate(_COLUMN_WIDTHS, start=1):
        worksheet.column_dimensions[get_column_letter(column)].width = width
    sku_width = max(12, max((len(str(item.get("sku") or "")) for item in items), default=0) + 4)
    worksheet.column_dimensions["D"].width = sku_width

    header_fill = PatternFill(fill_type="solid", fgColor="FFE2E8F0")
    header_border = Border(*[
        Side(style="thin", color="FFCBD5E1") for _ in range(4)
    ])
    for column, header in enumerate(_HEADERS, start=1):
        cell = worksheet.cell(1, column, header)
        cell.font = Font(name="Microsoft YaHei", bold=True, color="FF0F172A")
        cell.fill = header_fill
        cell.alignment = Alignment(vertical="center", horizontal="center", wrap_text=True)
        cell.border = header_border
    worksheet.row_dimensions[1].height = 22

    labels = _label_ranges(items)
    totals = {"cartons": 0, "quantity": 0, "volume": 0.0, "weight": 0.0}
    data_start_row = 2
    for index, item in enumerate(items):
        row_number = data_start_row + index
        length = float(item.get("length_cm") or 0)
        width = float(item.get("width_cm") or 0)
        height = float(item.get("height_cm") or 0)
        carton_weight = float(item.get("carton_weight_kg") or 0)
        units_per_carton = int(item.get("units_per_carton") or 0)
        carton_count = int(item.get("carton_count") or 0)
        quantity = int(item.get("quantity") or 0)
        volume = float(item.get("total_volume_m3") or 0)
        weight = float(item.get("total_weight_kg") or 0)
        totals["cartons"] += carton_count
        totals["quantity"] += quantity
        totals["volume"] += volume
        totals["weight"] += weight
        values = (
            item.get("shipment_no"),
            item.get("tracking_no") or "-",
            item.get("warehouse_code") or "-",
            item.get("sku") or "",
            item.get("product_name") or "-",
            None,
            item.get("asin") or "-",
            item.get("fnsku") or "-",
            _format_decimal(length, 2) if length > 0 else "-",
            _format_decimal(width, 2) if width > 0 else "-",
            _format_decimal(height, 2) if height > 0 else "-",
            _format_decimal(carton_weight, 3) if carton_weight else "-",
            f"{units_per_carton} / 箱" if units_per_carton > 0 else "-",
            carton_count if carton_count > 0 else "-",
            labels[index],
            quantity if quantity > 0 else "-",
            volume,
            weight,
        )
        worksheet.row_dimensions[row_number].height = 100
        for column, value in enumerate(values, start=1):
            cell = worksheet.cell(row_number, column, value)
            cell.font = Font(name="Microsoft YaHei", size=9, color="FF0F172A")
            cell.alignment = Alignment(
                vertical="center",
                horizontal="center" if column == 6 else "right" if column >= 13 else "left",
            )
            cell.border = Border(
                left=Side(style="thin", color="FFE2E8F0"),
                right=Side(style="thin", color="FFE2E8F0"),
                top=Side(style="thin", color="FFE2E8F0"),
                bottom=Side(style="thin", color="FFE2E8F0"),
            )
            if column in (13, 16):
                cell.number_format = "#,##0"
            elif column == 17:
                cell.number_format = "#,##0.0000"
            elif column == 18:
                cell.number_format = "#,##0.000"

    _style_group_banding(worksheet, items, data_start_row)
    _merge_adjacent_groups(
        worksheet, [(str(item.get("shipment_no") or ""),) for item in items], 1, data_start_row
    )
    _merge_adjacent_groups(
        worksheet,
        [(str(item.get("shipment_no") or ""), str(item.get("tracking_no") or "")) for item in items],
        2,
        data_start_row,
    )
    _merge_adjacent_groups(
        worksheet,
        [(str(item.get("shipment_no") or ""), str(item.get("warehouse_code") or "")) for item in items],
        3,
        data_start_row,
    )
    _attach_images(worksheet, items, data_start_row)

    total_row_number = data_start_row + len(items)
    total_row = worksheet.row_dimensions[total_row_number]
    total_row.height = 22
    total_values = {1: "合计", 14: totals["cartons"], 16: totals["quantity"], 17: totals["volume"], 18: totals["weight"]}
    for column in range(1, len(_HEADERS) + 1):
        cell = worksheet.cell(total_row_number, column, total_values.get(column))
        cell.font = Font(name="Microsoft YaHei", bold=True, color="FF0F172A")
        cell.fill = PatternFill(fill_type="solid", fgColor="FFF8FAFC")
        cell.alignment = Alignment(vertical="center", horizontal="right" if column in (14, 16, 17, 18) else "left")
        cell.border = Border(
            top=Side(style="medium", color="FF94A3B8"),
            left=Side(style="thin", color="FFCBD5E1"),
            bottom=Side(style="thin", color="FFCBD5E1"),
            right=Side(style="thin", color="FFCBD5E1"),
        )
    worksheet.cell(total_row_number, 14).number_format = "#,##0"
    worksheet.cell(total_row_number, 16).number_format = "#,##0"
    worksheet.cell(total_row_number, 17).number_format = "#,##0.0000"
    worksheet.cell(total_row_number, 18).number_format = "#,##0.000"

    output = io.BytesIO()
    workbook.save(output)
    return FbaBoxDetailsArtifact(
        filename=_build_filename(project_name, shipment_nos),
        content=output.getvalue(),
    )
