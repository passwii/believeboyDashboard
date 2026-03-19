from pathlib import Path
from datetime import date

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
                    report_date=date(2026, 3, 17),
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
    assert row.statuses["payment_report"].report_start_date == "2026-03-17"
    assert row.statuses["payment_report"].report_end_date == "2026-03-17"
    assert row.statuses["payment_report"].message == "周期覆盖已入库"


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
