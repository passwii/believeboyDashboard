"""回归测试：FBA 派送费 / FBA 库存和入库服务费 的拆分口径。

背景
----
Amazon 结算 CSV 把**仓储费**也写成 ``type = "FBA Transaction fees"``，
只有 ``description`` 才说明它其实是仓储费，例如::

    type="FBA Transaction fees", description="FBA Inventory Storage Fee"
    type="FBA Transaction fees", description="FBA Long Term Storage Fee"

旧口径把 ``FBA Transaction Fees`` 类型的行**整体**并进「FBA 派送费」
(``expense_fba_transaction_fees``），而「FBA 库存和入库服务费」
(``expense_fba_inventory_and_inbound_services_fees``) 只认
``type = "FBA Inventory Fee"``（该类型在真实月度文件里常常 0 行），结果是:

* 派送费虚高（把仓储费算进派送费）
* 库存和入库服务费恒为 0

修复后按 description 切分：**只有仓储类**（storage）→ 库存桶；其余 → 派送费桶。
两个桶金额之和不变（``expense_total`` 不受影响），只是归属纠正。

**业务口径确认（2026-09）**：``FBA Inbound Placement Service Fee``
（入库配置服务费）虽名义上属入库，但按业务口径归**派送费**，不属于库存桶；
``FBA Inbound Transportation Fee`` 同理。

本测试用 3 个月真实数值锁定口径：

======================  ==============  ====================
月份                    派送费          库存和入库服务费
======================  ==============  ====================
2026-07                 -173.80         -602.17
2026-08                 -450.81         -659.59
2026-09                 -2,972.49       -1,216.20
======================  ==============  ====================
"""
from __future__ import annotations

import csv
from decimal import Decimal
from pathlib import Path

from app.services.payment.classifier import classify_rows
from app.services.payment.financial import compute_metrics
from app.utils.payment_locale import is_fba_storage_fee

# ── 真实 2026-07 US 文件里的数值 ──────────────────────────────────────────────
# 18 条 FBA Order 行的 (fba fees, selling fees)。fba fees 是 Amazon 履约
# （拣货 / 打包 / 发货）收费，即“派送费”。
ORDER_ROWS = [
    ("-9.37", "-4.50"),
    ("-9.12", "-6.00"),
    ("-9.37", "-4.50"),
    ("-8.54", "-4.50"),
    ("-9.20", "-4.50"),
    ("-10.71", "-9.00"),
    ("-17.49", "-12.00"),
    ("-9.37", "-4.50"),
    ("-8.54", "-4.50"),
    ("-10.71", "-9.00"),
    ("-8.54", "-4.50"),
    ("0", "0"),
    ("-8.54", "-4.50"),
    ("-15.29", "-9.00"),
    ("-10.15", "-9.00"),
    ("-9.78", "-6.00"),
    ("-9.54", "-7.84"),
    ("-9.54", "-7.84"),
]
ORDER_SELLING_FEES_TOTAL = Decimal("-111.68")
ORDERS_FBA_FEES_TOTAL = Decimal("-173.80")

# 2 条仓储行（type="FBA Transaction Fees"）。
STORAGE_ROWS = [
    ("FBA Inventory Storage Fee", "-596.56"),
    ("FBA Long Term Storage Fee", "-5.61"),
]
STORAGE_TOTAL = Decimal("-602.17")

# 旧的（错误）合并口径 = 派送费 + 仓储费，用来证明拆分不丢钱。
LEGACY_COMBINED_TOTAL = Decimal("-775.97")
# 18 条订单 + 2 条仓储行下的合计费用（selling fees + 派送费 + 库存费）。
EXPECTED_EXPENSE_TOTAL = Decimal("-887.65")


def _fba_order_row(fba_fees: str, selling_fees: str, *, index: int) -> dict:
    """单条 FBA Order 行（canonical 列名，与 read_payment_csv 输出一致）。"""
    return {
        "type": "Order",
        "order id": f"114-0000000-{index:07d}",
        "sku": "QSK-5x8",
        "description": "BMCH Outdoor Rug",
        "quantity": "1",
        "fulfillment": "Amazon",
        "product sales": "0",
        "product sales tax": "0",
        "shipping credits": "0",
        "shipping credits tax": "0",
        "gift wrap credits": "0",
        "giftwrap credits tax": "0",
        "Regulatory Fee": "0",
        "Tax On Regulatory Fee": "0",
        "promotional rebates": "0",
        "promotional rebates tax": "0",
        "marketplace withheld tax": "0",
        "selling fees": selling_fees,
        "fba fees": fba_fees,
        "other transaction fees": "0",
        "other": "0",
        "total": "0",
    }


def _fba_transaction_fee_row(description: str, amount: str) -> dict:
    """单条 ``type="FBA Transaction Fees"`` 行（仓储 / 入库等）。"""
    return {
        "type": "FBA Transaction Fees",
        "order id": "",
        "sku": "",
        "description": description,
        "quantity": "",
        "fulfillment": "",
        "product sales": "0",
        "product sales tax": "0",
        "shipping credits": "0",
        "shipping credits tax": "0",
        "gift wrap credits": "0",
        "giftwrap credits tax": "0",
        "Regulatory Fee": "0",
        "Tax On Regulatory Fee": "0",
        "promotional rebates": "0",
        "promotional rebates tax": "0",
        "marketplace withheld tax": "0",
        "selling fees": "0",
        "fba fees": amount,
        "other transaction fees": "0",
        "other": "0",
        "total": amount,
    }


def _july_rows() -> list[dict]:
    rows = [
        _fba_order_row(fba_fees, selling_fees, index=idx)
        for idx, (fba_fees, selling_fees) in enumerate(ORDER_ROWS, start=1)
    ]
    rows += [
        _fba_transaction_fee_row(description, amount)
        for description, amount in STORAGE_ROWS
    ]
    return rows


class TestIsFbaStorageFee:
    """description 关键词判定的单元测试（US + DE）。"""

    def test_storage_descriptions_match(self):
        for description in (
            "FBA Inventory Storage Fee",
            "FBA Long Term Storage Fee",
            "FBA storage fee",
            "FBA Lagergebühr",  # DE：仓储费
        ):
            assert is_fba_storage_fee(description) is True, description

    def test_inbound_and_other_descriptions_do_not_match(self):
        """入库配置 / 入库运输费按业务口径归派送费，**不**匹配仓储。"""
        for description in (
            "",
            None,
            "FBA Inbound Placement Service Fee",
            "FBA Inbound Transportation Fee",
            "FBA Removal Order: Disposal Fee",
            "FBA Weight Based Fee",
            "FBA Customer Returns Fee",
        ):
            assert is_fba_storage_fee(description) is False, description


class TestClassifierSplit:
    """分类器把仓储行从 fba_transaction_fees 拆到库存桶。"""

    def test_storage_rows_land_in_inventory_bucket(self):
        classified = classify_rows(
            [_fba_transaction_fee_row(desc, amt) for desc, amt in STORAGE_ROWS]
        )
        assert len(classified["fba_inventory_and_inbound_fees"]) == 2
        assert classified["fba_transaction_fees"] == []

    def test_non_storage_transaction_fee_stays_in_transaction_bucket(self):
        classified = classify_rows(
            [_fba_transaction_fee_row("FBA Weight Based Fee", "-3.21")]
        )
        assert len(classified["fba_transaction_fees"]) == 1
        assert classified["fba_inventory_and_inbound_fees"] == []

    def test_de_storage_description_routes_to_inventory_bucket(self):
        classified = classify_rows(
            [_fba_transaction_fee_row("FBA Lagergebühr", "-12.00")]
        )
        assert len(classified["fba_inventory_and_inbound_fees"]) == 1
        assert classified["fba_transaction_fees"] == []

    def test_inbound_placement_fee_stays_in_transaction_bucket(self):
        """入库配置服务费归派送费（2026-09 业务口径确认）。"""
        classified = classify_rows(
            [
                _fba_transaction_fee_row("FBA Inbound Placement Service Fee", "-728.32"),
                _fba_transaction_fee_row("FBA Inbound Placement Service Fee", "-614.00"),
            ]
        )
        assert len(classified["fba_transaction_fees"]) == 2
        assert classified["fba_inventory_and_inbound_fees"] == []

    def test_buckets_are_disjoint(self):
        classified = classify_rows(_july_rows())
        inventory_ids = {id(r) for r in classified["fba_inventory_and_inbound_fees"]}
        transaction_ids = {id(r) for r in classified["fba_transaction_fees"]}
        assert inventory_ids & transaction_ids == set()


class TestComputeMetricsSplit:
    """2026-07 文件的核心回归：两个桶的金额归属。"""

    def test_fba_fees_split_matches_amazon_monthly_summary(self):
        classified = classify_rows(_july_rows())
        pt3 = compute_metrics(classified, country="US")["pt3"]

        # 派送费 = 18 条 Order 行的 fba fees（不含仓储行）
        assert pt3["expense_fba_transaction_fees"] == ORDERS_FBA_FEES_TOTAL
        # 库存和入库服务费 = 2 条仓储行
        assert (
            pt3["expense_fba_inventory_and_inbound_services_fees"] == STORAGE_TOTAL
        )

    def test_split_preserves_total_expense(self):
        """拆分是重分类，不是增减：两桶之和 == 旧的合并口径。"""
        classified = classify_rows(_july_rows())
        pt3 = compute_metrics(classified, country="US")["pt3"]

        combined = (
            pt3["expense_fba_transaction_fees"]
            + pt3["expense_fba_inventory_and_inbound_services_fees"]
        )
        assert combined == LEGACY_COMBINED_TOTAL

        # 若仓储费被重复计入（既在派送费又在库存费），合计会变成
        # -1459.14；这里锁住正确的 -887.65。
        assert pt3["expense_total"] == EXPECTED_EXPENSE_TOTAL
        assert (
            pt3["expense_total"]
            == pt3["expense_fba_selling_fees"]
            + pt3["expense_fba_transaction_fees"]
            + pt3["expense_fba_inventory_and_inbound_services_fees"]
        )

    def test_pt4_inventory_fee_follows_pt3(self):
        classified = classify_rows(_july_rows())
        metrics = compute_metrics(classified, country="US")
        assert metrics["pt4"]["expense_inventory_fee"] == STORAGE_TOTAL
        assert metrics["pt4"]["expense_fba_fee"] == ORDERS_FBA_FEES_TOTAL


class TestExportClassifierSplit:
    """导出明细页用的 ``_classify_monthly_rows`` 必须同口径。"""

    def test_export_classifier_routes_storage_to_inventory_bucket(self):
        from app.services.report.pt3 import _classify_monthly_rows

        classified = _classify_monthly_rows(_july_rows())
        assert len(classified["fba_inventory_and_inbound_fees"]) == 2
        assert classified["fba_transaction_fees"] == []

    def test_export_classifier_keeps_inbound_placement_in_transaction_bucket(self):
        from app.services.report.pt3 import _classify_monthly_rows

        classified = _classify_monthly_rows(
            [_fba_transaction_fee_row("FBA Inbound Placement Service Fee", "-728.32")]
        )
        assert len(classified["fba_transaction_fees"]) == 1
        assert classified["fba_inventory_and_inbound_fees"] == []


# ── 三个月真实数值回归（2026-07 / 08 / 09） ─────────────────────────
#
# 每条 case：月份、Order 行 fba fees 合计、仓储行、入库配置行（按业务口径归派送费）。
# Order 行用一条合成行携带真实合计值 —— 这两个桶只关心“订单 fba fees 合计”，
# 逐笔明细已在 ``ORDER_ROWS``（七月份）里逐行覆盖。
MONTHLY_CASES = [
    (
        "2026-07",
        "-173.80",
        [
            ("FBA Inventory Storage Fee", "-596.56"),
            ("FBA Long Term Storage Fee", "-5.61"),
        ],
        [],
        Decimal("-173.80"),
        Decimal("-602.17"),
    ),
    (
        "2026-08",
        "-450.81",
        [
            ("FBA Inventory Storage Fee", "-653.60"),
            ("FBA Long Term Storage Fee", "-5.99"),
        ],
        [],
        Decimal("-450.81"),
        Decimal("-659.59"),
    ),
    (
        "2026-09",
        "-1630.17",
        [("FBA Inventory Storage Fee", "-1216.20")],
        [
            ("FBA Inbound Placement Service Fee", "-728.32"),
            ("FBA Inbound Placement Service Fee", "-614.00"),
        ],
        Decimal("-2972.49"),
        Decimal("-1216.20"),
    ),
]


class TestMonthlyRegression:
    """三个月真实数值锁定拆分口径（含 2026-09 入库配置费归派送费）。"""

    def test_three_months_match_expected_split(self):
        for label, orders_total, storage, inbound, exp_delivery, exp_inventory in (
            MONTHLY_CASES
        ):
            rows = [_fba_order_row(orders_total, "0", index=1)]
            rows += [_fba_transaction_fee_row(d, a) for d, a in storage]
            rows += [_fba_transaction_fee_row(d, a) for d, a in inbound]

            pt3 = compute_metrics(classify_rows(rows), country="US")["pt3"]

            assert pt3["expense_fba_transaction_fees"] == exp_delivery, label
            assert (
                pt3["expense_fba_inventory_and_inbound_services_fees"]
                == exp_inventory
            ), label


# ── 端到端：真实 Amazon CSV 结构（前置说明行 + 表头 + 数据行） ────────────────

_CSV_HEADER = [
    "date/time",
    "settlement id",
    "type",
    "order id",
    "sku",
    "description",
    "quantity",
    "marketplace",
    "account type",
    "fulfillment",
    "order city",
    "order state",
    "order postal",
    "tax collection model",
    "product sales",
    "product sales tax",
    "shipping credits",
    "shipping credits tax",
    "gift wrap credits",
    "giftwrap credits tax",
    "Regulatory Fee",
    "Tax On Regulatory Fee",
    "promotional rebates",
    "promotional rebates tax",
    "marketplace withheld tax",
    "selling fees",
    "fba fees",
    "other transaction fees",
    "other",
    "total",
    "Transaction Status",
    "Transaction Release Date",
]


def _csv_row(**overrides: str) -> list[str]:
    values = dict.fromkeys(_CSV_HEADER, "0")
    values["date/time"] = "Jul 1, 2026 8:42:45 AM PDT"
    values["settlement id"] = "26987856661"
    values["marketplace"] = "amazon.com"
    values["account type"] = "Standard Orders"
    values["order city"] = "JOHNS ISLAND"
    values["order state"] = "SC"
    values["order postal"] = "29455"
    values["tax collection model"] = "MarketplaceFacilitator"
    values["Transaction Status"] = "Released"
    values["Transaction Release Date"] = "Jul 15, 2026 2:44:52 AM PDT"
    values.update(overrides)
    return [values[column] for column in _CSV_HEADER]


def _write_july_csv(path: Path) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        handle.write('"Includes Amazon Marketplace, Fulfillment by Amazon (FBA), and Amazon Webstore transactions"\n')
        handle.write('"All amounts in USD, unless specified"\n')
        handle.write('"Definitions:"\n')
        writer = csv.writer(handle)
        writer.writerow(_CSV_HEADER)
        for index, (fba_fees, selling_fees) in enumerate(ORDER_ROWS, start=1):
            writer.writerow(
                _csv_row(
                    type="Order",
                    **{
                        "order id": f"114-0000000-{index:07d}",
                        "sku": "QSK-5x8",
                        "description": "BMCH Outdoor Rug",
                        "quantity": "1",
                        "fulfillment": "Amazon",
                        "selling fees": selling_fees,
                        "fba fees": fba_fees,
                        "total": "0",
                    },
                )
            )
        for description, amount in STORAGE_ROWS:
            writer.writerow(
                _csv_row(
                    **{
                        "type": "FBA Transaction fees",
                        "description": description,
                        "fba fees": amount,
                        "total": amount,
                    }
                )
            )


class TestEndToEndPaymentCsv:
    """从真实结构的 CSV 读到 PT3，全链路验证拆分口径。"""

    def test_pipeline_splits_storage_from_delivery_fee(self, tmp_path: Path):
        from app.services.payment import read_payment_csv

        csv_path = tmp_path / "payment_2026_07.csv"
        _write_july_csv(csv_path)

        df = read_payment_csv(csv_path, country="US")
        rows = df.to_dict(orient="records")
        assert len(rows) == len(ORDER_ROWS) + len(STORAGE_ROWS)

        pt3 = compute_metrics(classify_rows(rows), country="US")["pt3"]
        assert pt3["expense_fba_transaction_fees"] == ORDERS_FBA_FEES_TOTAL
        assert (
            pt3["expense_fba_inventory_and_inbound_services_fees"] == STORAGE_TOTAL
        )
        assert pt3["expense_total"] == EXPECTED_EXPENSE_TOTAL
