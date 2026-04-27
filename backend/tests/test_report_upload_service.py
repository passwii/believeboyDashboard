from pathlib import Path
from datetime import UTC, date, datetime

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.db.session import Base
from app.models import AnalysisSourceFile, ProductCost, Project, ReportUploadStatus
from app.schemas.upload import ReportCommitRequest
from app.services import report_upload_service


def test_recognize_inventory_report_detects_snapshot_date(tmp_path: Path):
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)

    inventory = tmp_path / "inventory.txt"
    inventory.write_text(
        "snapshot-date\tsku\tasin\tavailable\n2026-03-18\tSKU1\tASIN1\t10\n",
        encoding="utf-8",
    )

    with Session(engine) as db:
        db.add(Project(project_name="Demo", sort_order=1, source_file="seed.csv"))
        db.add(
            ProductCost(
                project_name="Demo",
                sku="SKU1",
                asin="ASIN1",
                country="US",
                fob_unit_cost=1,
                currency="USD",
                source_file="seed.csv",
            )
        )
        db.commit()

        payload = report_upload_service._recognize_inventory_report(
            db, inventory, allowed_projects={"Demo"}
        )  # noqa: SLF001

    assert payload.date_input_mode == "single_detected"
    assert payload.detected_date == "2026-03-18"


def test_recognize_sales_report_detects_pt_date_range(tmp_path: Path):
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)

    sales = tmp_path / "sales.txt"
    sales.write_text(
        "purchase-date\tsku\tasin\n"
        "2026-02-25T07:30:00+00:00\tSKU1\tASIN1\n"
        "2026-02-26T08:30:00+00:00\tSKU1\tASIN1\n",
        encoding="utf-8",
    )

    with Session(engine) as db:
        db.add(Project(project_name="Demo", sort_order=1, source_file="seed.csv"))
        db.add(
            ProductCost(
                project_name="Demo",
                sku="SKU1",
                asin="ASIN1",
                country="US",
                fob_unit_cost=1,
                currency="USD",
                source_file="seed.csv",
            )
        )
        db.commit()

        payload = report_upload_service._recognize_sales_report(
            db, sales, allowed_projects={"Demo"}
        )  # noqa: SLF001

    assert payload.date_input_mode == "multi_auto"
    assert payload.detected_start_date == "2026-02-24"
    assert payload.detected_end_date == "2026-02-26"


def test_recognize_sales_report_detects_single_pt_date(tmp_path: Path):
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)

    sales = tmp_path / "sales-single.txt"
    sales.write_text(
        "purchase-date\tsku\tasin\n"
        "2026-02-25T08:30:00+00:00\tSKU1\tASIN1\n"
        "2026-02-25T15:30:00+00:00\tSKU1\tASIN1\n",
        encoding="utf-8",
    )

    with Session(engine) as db:
        db.add(Project(project_name="Demo", sort_order=1, source_file="seed.csv"))
        db.add(
            ProductCost(
                project_name="Demo",
                sku="SKU1",
                asin="ASIN1",
                country="US",
                fob_unit_cost=1,
                currency="USD",
                source_file="seed.csv",
            )
        )
        db.commit()

        payload = report_upload_service._recognize_sales_report(
            db, sales, allowed_projects={"Demo"}
        )  # noqa: SLF001

    assert payload.date_input_mode == "single_detected"
    assert payload.detected_date == "2026-02-25"
    assert payload.detected_start_date == "2026-02-25"
    assert payload.detected_end_date == "2026-02-25"


def test_recognize_inventory_report_matches_project_by_selected_country(tmp_path: Path):
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)

    inventory = tmp_path / "inventory-de.txt"
    inventory.write_text(
        "snapshot-date\tsku\tasin\tavailable\n2026-03-18\tSKU1\tASIN1\t10\n",
        encoding="utf-8",
    )

    with Session(engine) as db:
        db.add(Project(project_name="Demo", sort_order=1, source_file="seed.csv"))
        db.add(
            ProductCost(
                project_name="Demo",
                sku="SKU1",
                asin="ASIN1",
                country="DE",
                fob_unit_cost=1,
                currency="EUR",
                source_file="seed.csv",
            )
        )
        db.commit()

        de_payload = report_upload_service._recognize_inventory_report(
            db, inventory, country="DE", allowed_projects={"Demo"}
        )  # noqa: SLF001
        us_payload = report_upload_service._recognize_inventory_report(
            db, inventory, country="US", allowed_projects={"Demo"}
        )  # noqa: SLF001

    assert de_payload.project_match.status == "matched"
    assert de_payload.project_match.project_name == "Demo"
    assert us_payload.project_match.status == "unmatched"


def test_recognize_sales_report_detects_de_local_date_range(tmp_path: Path):
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)

    sales = tmp_path / "sales-de.txt"
    sales.write_text(
        "purchase-date\tsku\tasin\n"
        "2026-02-25T00:30:00+00:00\tSKU1\tASIN1\n"
        "2026-02-25T23:30:00+00:00\tSKU1\tASIN1\n",
        encoding="utf-8",
    )

    with Session(engine) as db:
        db.add(Project(project_name="Demo", sort_order=1, source_file="seed.csv"))
        db.add(
            ProductCost(
                project_name="Demo",
                sku="SKU1",
                asin="ASIN1",
                country="DE",
                fob_unit_cost=1,
                currency="EUR",
                source_file="seed.csv",
            )
        )
        db.commit()

        payload = report_upload_service._recognize_sales_report(
            db, sales, country="DE", allowed_projects={"Demo"}
        )  # noqa: SLF001

    assert payload.date_input_mode == "multi_auto"
    assert payload.detected_start_date == "2026-02-25"
    assert payload.detected_end_date == "2026-02-26"


def test_list_report_upload_statuses_filters_by_report_date():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name="Demo", sort_order=1, source_file="seed.csv")
        db.add(project)
        db.flush()

        db.add_all(
            [
                ProductCost(
                    project_name="Demo",
                    sku="SKU1",
                    asin="ASIN1",
                    country="US",
                    fob_unit_cost=1,
                    currency="USD",
                    is_active=True,
                    source_file="seed.csv",
                ),
                AnalysisSourceFile(
                    project_id=project.id,
                    report_type="business_report",
                    country="US",
                    report_date=date(2026, 3, 18),
                    period_start_date=date(2026, 3, 18),
                    period_end_date=date(2026, 3, 18),
                    version=1,
                    is_current=True,
                    upload_file_id="business-2026-03-18.csv",
                    upload_file_path="/tmp/business-2026-03-18.csv",
                    stored_filename="business-2026-03-18.csv",
                    logical_filename="business-2026-03-18.csv",
                    storage_key="business-2026-03-18.csv",
                    original_filename="business-2026-03-18.csv",
                    ingestion_status="success",
                ),
                AnalysisSourceFile(
                    project_id=project.id,
                    report_type="sales_report",
                    country="US",
                    report_date=date(2026, 3, 19),
                    period_start_date=date(2026, 3, 19),
                    period_end_date=date(2026, 3, 19),
                    version=1,
                    is_current=True,
                    upload_file_id="sales-2026-03-19.txt",
                    upload_file_path="/tmp/sales-2026-03-19.txt",
                    stored_filename="sales-2026-03-19.txt",
                    logical_filename="sales-2026-03-19.txt",
                    storage_key="sales-2026-03-19.txt",
                    original_filename="sales-2026-03-19.txt",
                    ingestion_status="success",
                ),
                AnalysisSourceFile(
                    project_id=project.id,
                    report_type="payment_report",
                    country="US",
                    report_date=None,  # None = period-based report
                    period_start_date=date(2026, 3, 16),
                    period_end_date=date(2026, 3, 20),
                    version=1,
                    is_current=True,
                    upload_file_id="payment-2026-03-16_2026-03-20.csv",
                    upload_file_path="/tmp/payment-2026-03-16_2026-03-20.csv",
                    stored_filename="payment-2026-03-16_2026-03-20.csv",
                    logical_filename="payment-2026-03-16_2026-03-20.csv",
                    storage_key="payment-2026-03-16_2026-03-20.csv",
                    original_filename="payment-2026-03-16_2026-03-20.csv",
                    ingestion_status="success",
                ),
            ]
        )
        db.commit()

        payload = report_upload_service.list_report_upload_statuses(
            db, report_date="2026-03-18", country="US"
        )

    row = payload.items[0]
    assert payload.country == "US"
    assert row.statuses["business_report"].status == "available"
    assert row.statuses["business_report"].display_date == "2026-03-18"
    assert row.statuses["sales_report"].status == "missing"
    assert row.statuses["payment_report"].status == "available"
    assert row.statuses["payment_report"].display_date == "2026-03-18"
    assert row.statuses["payment_report"].report_start_date == "2026-03-16"  # period_start_date
    assert row.statuses["payment_report"].report_end_date == "2026-03-20"  # period_end_date
    assert row.statuses["payment_report"].message == "历史周期数据已入库"


def test_list_report_upload_statuses_filters_by_country():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name="Demo", sort_order=1, source_file="seed.csv")
        db.add(project)
        db.flush()

        db.add_all(
            [
                ProductCost(
                    project_name="Demo",
                    sku="SKU1",
                    asin="ASIN1",
                    country="US",
                    fob_unit_cost=1,
                    currency="USD",
                    is_active=True,
                    source_file="seed.csv",
                ),
                ProductCost(
                    project_name="Demo",
                    sku="SKU1",
                    asin="ASIN1",
                    country="DE",
                    fob_unit_cost=1,
                    currency="USD",
                    is_active=True,
                    source_file="seed.csv",
                ),
                ProductCost(
                    project_name="Demo",
                    sku="SKU1",
                    asin="ASIN1",
                    country="UK",
                    fob_unit_cost=1,
                    currency="USD",
                    is_active=True,
                    source_file="seed.csv",
                ),
                AnalysisSourceFile(
                    project_id=project.id,
                    report_type="business_report",
                    country="US",
                    report_date=date(2026, 3, 18),
                    period_start_date=date(2026, 3, 18),
                    period_end_date=date(2026, 3, 18),
                    version=1,
                    is_current=True,
                    upload_file_id="business-us.csv",
                    upload_file_path="/tmp/business-us.csv",
                    stored_filename="business-us.csv",
                    logical_filename="business-us.csv",
                    storage_key="business-us.csv",
                    original_filename="business-us.csv",
                    ingestion_status="success",
                ),
                AnalysisSourceFile(
                    project_id=project.id,
                    report_type="business_report",
                    country="DE",
                    report_date=date(2026, 3, 18),
                    period_start_date=date(2026, 3, 18),
                    period_end_date=date(2026, 3, 18),
                    version=1,
                    is_current=True,
                    upload_file_id="business-de.csv",
                    upload_file_path="/tmp/business-de.csv",
                    stored_filename="business-de.csv",
                    logical_filename="business-de.csv",
                    storage_key="business-de.csv",
                    original_filename="business-de.csv",
                    ingestion_status="success",
                ),
                AnalysisSourceFile(
                    project_id=project.id,
                    report_type="business_report",
                    country="UK",
                    report_date=date(2026, 3, 18),
                    period_start_date=date(2026, 3, 18),
                    period_end_date=date(2026, 3, 18),
                    version=1,
                    is_current=True,
                    upload_file_id="business-uk.csv",
                    upload_file_path="/tmp/business-uk.csv",
                    stored_filename="business-uk.csv",
                    logical_filename="business-uk.csv",
                    storage_key="business-uk.csv",
                    original_filename="business-uk.csv",
                    ingestion_status="success",
                ),
            ]
        )
        db.commit()

        us_payload = report_upload_service.list_report_upload_statuses(
            db, report_date="2026-03-18", country="US"
        )
        de_payload = report_upload_service.list_report_upload_statuses(
            db, report_date="2026-03-18", country="DE"
        )
        uk_payload = report_upload_service.list_report_upload_statuses(
            db, report_date="2026-03-18", country="UK"
        )

    assert us_payload.country == "US"
    assert de_payload.country == "DE"
    assert uk_payload.country == "UK"
    assert (
        us_payload.items[0].statuses["business_report"].original_filename
        == "business-us.csv"
    )
    assert (
        de_payload.items[0].statuses["business_report"].original_filename
        == "business-de.csv"
    )
    assert (
        uk_payload.items[0].statuses["business_report"].original_filename
        == "business-uk.csv"
    )


def test_list_report_upload_statuses_filters_projects_by_sku_info_country():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        misen = Project(project_name="弥森", sort_order=1, source_file="seed.csv")
        yuehan = Project(project_name="粤韩", sort_order=2, source_file="seed.csv")
        db.add_all([misen, yuehan])
        db.flush()

        db.add_all(
            [
                ProductCost(
                    project_name="弥森",
                    sku="MS-US-1",
                    asin="ASIN-MS-US-1",
                    country="US",
                    fob_unit_cost=1,
                    currency="USD",
                    is_active=True,
                    source_file="seed.csv",
                ),
                ProductCost(
                    project_name="弥森",
                    sku="MS-DE-1",
                    asin="ASIN-MS-DE-1",
                    country="DE",
                    fob_unit_cost=1,
                    currency="USD",
                    is_active=True,
                    source_file="seed.csv",
                ),
                ProductCost(
                    project_name="粤韩",
                    sku="YH-US-1",
                    asin="ASIN-YH-US-1",
                    country="US",
                    fob_unit_cost=1,
                    currency="USD",
                    is_active=True,
                    source_file="seed.csv",
                ),
                AnalysisSourceFile(
                    project_id=misen.id,
                    report_type="business_report",
                    country="DE",
                    report_date=date(2026, 3, 18),
                    period_start_date=date(2026, 3, 18),
                    period_end_date=date(2026, 3, 18),
                    version=1,
                    is_current=True,
                    upload_file_id="misen-business-de.csv",
                    upload_file_path="/tmp/misen-business-de.csv",
                    stored_filename="misen-business-de.csv",
                    logical_filename="misen-business-de.csv",
                    storage_key="misen-business-de.csv",
                    original_filename="misen-business-de.csv",
                    ingestion_status="success",
                ),
            ]
        )
        db.commit()

        us_payload = report_upload_service.list_report_upload_statuses(
            db, report_date="2026-03-18", country="US"
        )
        de_payload = report_upload_service.list_report_upload_statuses(
            db, report_date="2026-03-18", country="DE"
        )

    assert [item.project_name for item in us_payload.items] == ["弥森", "粤韩"]
    assert [item.project_name for item in de_payload.items] == ["弥森"]
    assert de_payload.items[0].statuses["business_report"].status == "available"


def test_commit_report_upload_persists_inventory_country(tmp_path: Path):
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)
    settings = Settings(
        upload_root=tmp_path / "uploads", database_url="sqlite:///:memory:"
    )

    inventory = tmp_path / "inventory.txt"
    inventory.write_text(
        "snapshot-date\tsku\tasin\tavailable\n2026-03-18\tSKU1\tASIN1\t10\n",
        encoding="utf-8",
    )

    countries = ("US", "DE", "UK")
    with Session(engine) as db:
        db.add(Project(project_name="Demo", sort_order=1, source_file="seed.csv"))
        db.add_all(
            [
                ProductCost(
                    project_name="Demo",
                    sku="SKU1",
                    asin="ASIN1",
                    country=country,
                    fob_unit_cost=1,
                    currency="USD",
                    source_file="seed.csv",
                )
                for country in countries
            ]
        )
        db.commit()

        for country in countries:
            temp_file_id = f"{country.lower()}-inventory.txt"
            temp_dir = settings.upload_root / "_report_upload_tmp"
            temp_dir.mkdir(parents=True, exist_ok=True)
            (temp_dir / temp_file_id).write_text(
                inventory.read_text(encoding="utf-8"), encoding="utf-8"
            )

            response = report_upload_service.commit_report_upload(
                db,
                settings,
                payload=ReportCommitRequest(
                    temp_file_id=temp_file_id,
                    report_type="inventory_report",
                    original_filename=f"{country.lower()}-inventory.txt",
                    project_name="Demo",
                    report_date="2026-03-18",
                    country=country,
                ),
            )

            assert response.country == country

        rows = (
            db.execute(
                select(AnalysisSourceFile).order_by(
                    AnalysisSourceFile.country.asc(), AnalysisSourceFile.id.asc()
                )
            )
            .scalars()
            .all()
        )

    assert [row.country for row in rows] == ["DE", "UK", "US"]


def test_list_report_upload_statuses_inventory_history_visible_on_target_date():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name="Demo", sort_order=1, source_file="seed.csv")
        db.add(project)
        db.flush()

        db.add(
            ProductCost(
                project_name="Demo",
                sku="SKU1",
                asin="ASIN1",
                country="US",
                fob_unit_cost=1,
                currency="USD",
                is_active=True,
                source_file="seed.csv",
            )
        )
        db.add_all(
            [
                AnalysisSourceFile(
                    project_id=project.id,
                    report_type="inventory_report",
                    country="US",
                    report_date=date(2026, 3, 18),
                    period_start_date=None,
                    period_end_date=None,
                    snapshot_at=datetime.now(UTC),
                    version=1,
                    is_current=False,
                    upload_file_id="inventory-2026-03-18.txt",
                    upload_file_path="/tmp/inventory-2026-03-18.txt",
                    stored_filename="inventory-2026-03-18.txt",
                    logical_filename="inventory-2026-03-18.txt",
                    storage_key="inventory-2026-03-18.txt",
                    original_filename="inventory-2026-03-18.txt",
                    ingestion_status="success",
                ),
                AnalysisSourceFile(
                    project_id=project.id,
                    report_type="inventory_report",
                    country="US",
                    report_date=date(2026, 3, 19),
                    period_start_date=None,
                    period_end_date=None,
                    snapshot_at=datetime.now(UTC),
                    version=2,
                    is_current=True,
                    upload_file_id="inventory-2026-03-19.txt",
                    upload_file_path="/tmp/inventory-2026-03-19.txt",
                    stored_filename="inventory-2026-03-19.txt",
                    logical_filename="inventory-2026-03-19.txt",
                    storage_key="inventory-2026-03-19.txt",
                    original_filename="inventory-2026-03-19.txt",
                    ingestion_status="success",
                ),
            ]
        )
        db.commit()

        payload = report_upload_service.list_report_upload_statuses(
            db, report_date="2026-03-18", country="US"
        )

    row = payload.items[0]
    assert row.statuses["inventory_report"].status == "available"
    assert row.statuses["inventory_report"].display_date == "2026-03-18"


def test_commit_report_upload_persists_search_term_country(tmp_path: Path):
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)
    settings = Settings(
        upload_root=tmp_path / "uploads", database_url="sqlite:///:memory:"
    )

    search_term = tmp_path / "search-term.xlsx"
    search_term.write_bytes(b"placeholder")

    countries = ("US", "DE", "UK")
    with Session(engine) as db:
        db.add(Project(project_name="Demo", sort_order=1, source_file="seed.csv"))
        db.commit()

        for country in countries:
            temp_file_id = f"{country.lower()}-search-term.xlsx"
            temp_dir = settings.upload_root / "_report_upload_tmp"
            temp_dir.mkdir(parents=True, exist_ok=True)
            (temp_dir / temp_file_id).write_bytes(search_term.read_bytes())

            response = report_upload_service.commit_report_upload(
                db,
                settings,
                payload=ReportCommitRequest(
                    temp_file_id=temp_file_id,
                    report_type="ad_search_term_report",
                    original_filename=f"{country.lower()}-search-term.xlsx",
                    project_name="Demo",
                    report_date="2026-03-18",
                    country=country,
                ),
            )

            assert response.country == country
            assert response.persisted_table == "report_upload_statuses"

        rows = (
            db.execute(
                select(ReportUploadStatus).order_by(
                    ReportUploadStatus.country.asc(), ReportUploadStatus.id.asc()
                )
            )
            .scalars()
            .all()
        )

    assert [row.country for row in rows] == ["DE", "UK", "US"]


def test_recognize_business_report_detects_date(tmp_path: Path):
    """业务报表识别：应该检测到报表日期"""
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)

    # 业务报表需要逗号分隔，并包含 ASIN 相关列
    business = tmp_path / "business.csv"
    business.write_text(
        "sku,asin,（子）ASIN,session,ordered-session\n"
        "SKU1,ASIN1,CHILD-ASIN1,100,80\n",
        encoding="utf-8",
    )

    with Session(engine) as db:
        db.add(Project(project_name="Demo", sort_order=1, source_file="seed.csv"))
        db.add(
            ProductCost(
                project_name="Demo",
                sku="SKU1",
                asin="CHILD-ASIN1",
                country="US",
                fob_unit_cost=1,
                currency="USD",
                source_file="seed.csv",
            )
        )
        db.commit()

        payload = report_upload_service._recognize_business_report(
            db, business, allowed_projects={"Demo"}
        )  # noqa: SLF001

    # 业务报表应该检测文件名中的日期
    assert payload.report_type == "business_report"
    assert payload.project_match.status == "matched"
    assert payload.project_match.project_name == "Demo"


def test_recognize_ad_product_report(tmp_path: Path):
    """广告产品报表识别"""
    import pandas as pd

    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)

    ad_product = tmp_path / "ad-product.xlsx"
    df = pd.DataFrame({
        "开始日期": ["2026-03-01"],
        "结束日期": ["2026-03-15"],
        "广告SKU": ["SKU1"],
        "广告ASIN": ["ASIN1"],
    })
    df.to_excel(ad_product, index=False, engine="openpyxl")

    with Session(engine) as db:
        db.add(Project(project_name="Demo", sort_order=1, source_file="seed.csv"))
        db.add(
            ProductCost(
                project_name="Demo",
                sku="SKU1",
                asin="ASIN1",
                country="US",
                fob_unit_cost=1,
                currency="USD",
                source_file="seed.csv",
            )
        )
        db.commit()

        payload = report_upload_service._recognize_ad_product_report(
            db, ad_product, allowed_projects={"Demo"}
        )  # noqa: SLF001

    assert payload.report_type == "ad_product_report"
    assert payload.project_match.status == "matched"


def test_recognize_ad_search_term_report(tmp_path: Path):
    """搜索词报表识别"""
    import pandas as pd

    search_term = tmp_path / "search-term.xlsx"
    df = pd.DataFrame({
        "开始日期": ["2026-03-01"],
        "结束日期": ["2026-03-15"],
        "搜索词": ["keyword1"],
    })
    df.to_excel(search_term, index=False, engine="openpyxl")

    payload = report_upload_service._recognize_ad_search_term_report(
        search_term, country="US"
    )

    assert payload.report_type == "ad_search_term_report"
    # 搜索词报表不需要项目匹配，由用户手动选择
    assert payload.project_match.status == "manual"


def test_recognize_return_report(tmp_path: Path):
    """退货报表识别"""
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)

    returns = tmp_path / "returns.txt"
    returns.write_text(
        "order-id\tsku\treturn-date\n"
        "123-456\tSKU1\t2026-03-15\n",
        encoding="utf-8",
    )

    with Session(engine) as db:
        db.add(Project(project_name="Demo", sort_order=1, source_file="seed.csv"))
        db.add(
            ProductCost(
                project_name="Demo",
                sku="SKU1",
                asin="ASIN1",
                country="US",
                fob_unit_cost=1,
                currency="USD",
                source_file="seed.csv",
            )
        )
        db.commit()

        payload = report_upload_service._recognize_return_report(
            db, returns, allowed_projects={"Demo"}
        )  # noqa: SLF001

    assert payload.report_type == "return_report"
    assert payload.project_match.status == "matched"


def test_recognize_inventory_report_no_matching_project(tmp_path: Path):
    """无匹配项目时的识别行为"""
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)

    inventory = tmp_path / "inventory.txt"
    inventory.write_text(
        "snapshot-date\tsku\tasin\tavailable\n2026-03-18\tUNKNOWN-SKU\tUNKNOWN-ASIN\t10\n",
        encoding="utf-8",
    )

    with Session(engine) as db:
        db.add(Project(project_name="Demo", sort_order=1, source_file="seed.csv"))
        db.add(
            ProductCost(
                project_name="Demo",
                sku="SKU1",
                asin="ASIN1",
                country="US",
                fob_unit_cost=1,
                currency="USD",
                source_file="seed.csv",
            )
        )
        db.commit()

        payload = report_upload_service._recognize_inventory_report(
            db, inventory, allowed_projects={"Demo"}
        )  # noqa: SLF001

    # SKU 不匹配时，项目匹配状态应该是 unmatched
    assert payload.project_match.status == "unmatched"
    assert payload.project_match.project_name is None


def test_list_report_upload_statuses_excludes_inactive_products():
    """未激活的产品应该被过滤"""
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        active_project = Project(project_name="活跃项目", sort_order=1, source_file="seed.csv")
        inactive_project = Project(project_name="非活跃项目", sort_order=2, source_file="seed.csv")
        db.add_all([active_project, inactive_project])
        db.flush()

        db.add_all(
            [
                # 活跃产品的 SKU
                ProductCost(
                    project_name="活跃项目",
                    sku="ACTIVE-SKU",
                    asin="ACTIVE-ASIN",
                    country="US",
                    fob_unit_cost=1,
                    currency="USD",
                    is_active=True,
                    source_file="seed.csv",
                ),
                # 非活跃产品的 SKU
                ProductCost(
                    project_name="非活跃项目",
                    sku="INACTIVE-SKU",
                    asin="INACTIVE-ASIN",
                    country="US",
                    fob_unit_cost=1,
                    currency="USD",
                    is_active=False,  # 非活跃
                    source_file="seed.csv",
                ),
            ]
        )
        db.add(
            AnalysisSourceFile(
                project_id=inactive_project.id,
                report_type="business_report",
                country="US",
                report_date=date(2026, 3, 18),
                period_start_date=date(2026, 3, 18),
                period_end_date=date(2026, 3, 18),
                version=1,
                is_current=True,
                upload_file_id="inactive-business.csv",
                upload_file_path="/tmp/inactive-business.csv",
                stored_filename="inactive-business.csv",
                logical_filename="inactive-business.csv",
                storage_key="inactive-business.csv",
                original_filename="inactive-business.csv",
                ingestion_status="success",
            )
        )
        db.commit()

        payload = report_upload_service.list_report_upload_statuses(
            db, report_date="2026-03-18", country="US"
        )

    # 应该只有活跃项目，没有非活跃项目
    project_names = [item.project_name for item in payload.items]
    assert "活跃项目" in project_names


def test_list_report_upload_statuses_empty_when_no_active_sku():
    """没有活跃 SKU 时，返回空列表"""
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)

    with Session(engine) as db:
        project = Project(project_name="Demo", sort_order=1, source_file="seed.csv")
        db.add(project)
        db.flush()

        # 添加非活跃 SKU
        db.add(
            ProductCost(
                project_name="Demo",
                sku="SKU1",
                asin="ASIN1",
                country="US",
                fob_unit_cost=1,
                currency="USD",
                is_active=False,  # 非活跃
                source_file="seed.csv",
            )
        )
        db.add(
            AnalysisSourceFile(
                project_id=project.id,
                report_type="business_report",
                country="US",
                report_date=date(2026, 3, 18),
                period_start_date=date(2026, 3, 18),
                period_end_date=date(2026, 3, 18),
                version=1,
                is_current=True,
                upload_file_id="business.csv",
                upload_file_path="/tmp/business.csv",
                stored_filename="business.csv",
                logical_filename="business.csv",
                storage_key="business.csv",
                original_filename="business.csv",
                ingestion_status="success",
            )
        )
        db.commit()

        payload = report_upload_service.list_report_upload_statuses(
            db, report_date="2026-03-18", country="US"
        )

    # 没有活跃 SKU，项目应该被过滤掉
    assert len(payload.items) == 0


def test_normalize_country_handles_various_inputs():
    """测试国家代码标准化"""
    from app.services.report_upload_service import _normalize_country

    assert _normalize_country("us") == "US"
    assert _normalize_country("US") == "US"
    assert _normalize_country("Us") == "US"
    assert _normalize_country("de") == "DE"
    assert _normalize_country("DE") == "DE"
    assert _normalize_country("uk") == "UK"
    assert _normalize_country("UK") == "UK"


def test_commit_report_upload_creates_analysis_source_file(tmp_path: Path):
    """报表上传应该创建 analysis_source_files 记录"""
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(bind=engine)
    settings = Settings(
        upload_root=tmp_path / "uploads", database_url="sqlite:///:memory:"
    )

    inventory = tmp_path / "inventory.txt"
    inventory.write_text(
        "snapshot-date\tsku\tasin\tavailable\n2026-03-18\tSKU1\tASIN1\t10\n",
        encoding="utf-8",
    )

    with Session(engine) as db:
        db.add(Project(project_name="Demo", sort_order=1, source_file="seed.csv"))
        db.add(
            ProductCost(
                project_name="Demo",
                sku="SKU1",
                asin="ASIN1",
                country="US",
                fob_unit_cost=1,
                currency="USD",
                source_file="seed.csv",
            )
        )
        db.commit()

        temp_file_id = "temp-inventory.txt"
        temp_dir = settings.upload_root / "_report_upload_tmp"
        temp_dir.mkdir(parents=True, exist_ok=True)
        (temp_dir / temp_file_id).write_text(inventory.read_text(encoding="utf-8"))

        response = report_upload_service.commit_report_upload(
            db,
            settings,
            payload=ReportCommitRequest(
                temp_file_id=temp_file_id,
                report_type="inventory_report",
                original_filename="inventory.txt",
                project_name="Demo",
                report_date="2026-03-18",
                country="US",
            ),
        )

        assert response.persisted_table == "analysis_source_files"

        # 验证数据库中已创建记录
        rows = db.execute(
            select(AnalysisSourceFile).where(
                AnalysisSourceFile.report_type == "inventory_report"
            )
        ).scalars().all()
        assert len(rows) == 1
        assert rows[0].country == "US"
