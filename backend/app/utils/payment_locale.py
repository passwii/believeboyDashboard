from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

# BLF-1036: pandas imported lazily — this module sits on the API/worker boot
# import chain via app.services.report.monthly; the pandas stack costs ~65MB
# RSS in processes that never parse payment reports.
if TYPE_CHECKING:
    import pandas as pd

from app.utils.country import COUNTRY_TO_LOCALE, normalize_country


@dataclass
class PaymentReportStructure:
    skiprows: int
    delimiter: str
    column_mapping: dict[str, str]
    locale: str


# Header markers that identify a file as a payment report (scanned in first 15 lines)
PAYMENT_REPORT_HEADER_MARKERS = [
    "Includes Amazon Marketplace",
    "Einschließlich Transaktionen zu Amazon Marketplace",
]

PAYMENT_REPORT_COLUMN_ALIASES = {
    'date/time': ['date/time', 'datum/uhrzeit'],
    'settlement id': ['settlement id', 'abrechnungsnummer'],
    'type': ['type', 'typ'],
    'order id': ['order id', 'bestellnummer'],
    'sku': ['sku', 'sku'],
    'description': ['description', 'beschreibung'],
    'quantity': ['quantity', 'menge'],
    'marketplace': ['marketplace', 'marketplace'],
    'account type': ['account type'],
    'fulfillment': ['fulfillment', 'fulfilment', 'versand'],
    'order city': ['order city', 'ort der bestellung'],
    'order state': ['order state', 'bundesland'],
    'order postal': ['order postal', 'postleitzahl'],
    'tax collection model': ['tax collection model', 'steuererhebungsmodell'],
    'product sales': ['product sales', 'umsaetze'],
    'product sales tax': ['product sales tax', 'produktumsatzsteuer'],
    'shipping credits': ['shipping credits', 'postage credits', 'gutschrift fuer versandkosten'],
    'shipping credits tax': ['shipping credits tax', 'steuer auf versandgutschrift'],
    'gift wrap credits': ['gift wrap credits', 'gutschrift fuer geschenkverpackung'],
    'giftwrap credits tax': ['giftwrap credits tax', 'steuer auf geschenkverpackungsgutschriften'],
    'regulatory fee': ['regulatory fee'],
    'tax on regulatory fee': ['tax on regulatory fee'],
    'promotional rebates': ['promotional rebates', 'rabatte aus werbeaktionen'],
    'promotional rebates tax': ['promotional rebates tax', 'steuer auf aktionsrabatte'],
    'marketplace withheld tax': ['marketplace withheld tax', 'einbehaltene steuer auf marketplace'],
    'selling fees': ['selling fees', 'verkaufsgebuehren'],
    'fba fees': ['fba fees', 'gebuehren zu versand durch amazon'],
    'other transaction fees': ['other transaction fees', 'andere transaktionsgebuehren'],
    'other': ['other', 'andere'],
    'total': ['total', 'gesamt'],
    'transaction status': ['transaction status', 'transaktionsstatus'],
    'transaction release date': ['transaction release date', 'freigabedatum der transaktion'],
}

PAYMENT_REPORT_REQUIRED_COLUMNS = {
    'type',
    'sku',
    'quantity',
    'product sales',
    'shipping credits',
    'promotional rebates',
    'other',
    'selling fees',
    'fba fees',
}

PAYMENT_NUMERIC_COLUMNS = {
    'quantity',
    'product sales',
    'product sales tax',
    'shipping credits',
    'shipping credits tax',
    'gift wrap credits',
    'giftwrap credits tax',
    'regulatory fee',
    'tax on regulatory fee',
    'promotional rebates',
    'promotional rebates tax',
    'marketplace withheld tax',
    'selling fees',
    'fba fees',
    'other transaction fees',
    'other',
    'total',
}

PAYMENT_TYPE_ALIASES = {
    'Order': ['order', 'bestellung'],
    'Refund': ['refund', 'erstattung'],
    'Amazon Fees': ['amazon fees', 'gebuehren von amazon'],
    'Service Fee': ['service fee', 'servicegebuehr'],
    'FBA Inventory Fee': ['fba inventory fee', 'versand durch amazon lagergebuehr'],
    'Transfer': ['transfer', 'uebertrag'],
    'FBA Transaction Fees': [
        'fba transaction fees',
        'transaktionsgebuehren fuer versand durch amazon',
        'fulfilment by amazon (fba) transaction fees',
    ],
    'Chargeback Refund': ['chargeback refund'],
    'Liquidations': ['liquidations'],
    'Adjustment': ['adjustment', 'anpassung'],
    'Deal Fee': ['deal fee'],
    'Debt': ['debt', 'verbindlichkeit'],
    'Fee Adjustment': ['fee adjustment'],
}


PAYMENT_DESCRIPTION_ALIASES = {
    'Cost of Advertising': ['cost of advertising', 'werbekosten'],
    'Refund for Advertiser': [
        'refund for advertiser',
        'werbekosten-erstattung',
        'erstattung werbekosten',
    ],
    'FBA Inventory Reimbursement - General Adjustment': [
        'fba inventory reimbursement - general adjustment',
        'fba-bestandsentschaedigung - allgemeine anpassung',
        # BEL-XXX: full German long-form Amazon DE actually exports
        # ("Versand durch Amazon Erstattung für Lagerbestand - Allgemeine
        # Anpassung"). Without this, double-space variants of the same
        # string were leaking into adjustment_income in classifier.py.
        'versand durch amazon erstattung für lagerbestand - allgemeine anpassung',
    ],
    'FBA Inventory Reimbursement - Lost': [
        'fba inventory reimbursement - lost',
        'versand durch amazon erstattung fuer lagerbestand - im lager verloren',
    ],
    'Non-subscription Fee Adjustment': [
        'non-subscription fee adjustment',
        'nicht-abonnement-gebu ehrenanpassung',
    ],
    'FBA International Freight Shipping Charge': [
        'fba international freight shipping charge',
        'fba internationale frachtversandkosten',
    ],
    'FBA International Freight Duties and Taxes Charge': [
        'fba international freight duties and taxes charge',
        'fba internationale frachtzoelle und steuern',
    ],
    'Fee Adjustment - Weight and Dimension Change': [
        'fee adjustment - weight and dimension change',
        'gebuehrenanpassung - gewichts- und massaenderung',
    ],
    'Deal Participation Fee': [
        'deal participation fee',
        'teilnahmegebuehr fuer das angebot',
    ],
    'Deal Performance Based Fee': [
        'deal performance based fee',
        'leistungsbasierte angebotsgebuehr',
    ],
    'Coupon Participation Fee': [
        'coupon participation fee',
        'coupon-teilnahmegebuehr',
    ],
    'Coupon Performance Based Fee': [
        'coupon performance based fee',
        'leistungsbasierte coupon-gebuehr',
    ],
    'Vine Enrollment Fee': [
        'vine enrollment fee',
        'vine-registrierungsgebuehr',
    ],
    'FBA storage fee': [
        'fba storage fee',
        'fba-lagergebuehr',
        'fba lagergebuehr',
    ],
    'FBA Removal Order: Disposal Fee': [
        'fba removal order: disposal fee',
        'versand durch amazon gebuehr fuer entsorgung',
    ],
    'FBA Removal Order: Return Fee': [
        'fba removal order: return fee',
        'versand durch amazon gebuehr fuer ruecksendung',
    ],
    'FBA Long-Term Storage Fee': [
        'fba long-term storage fee',
        'fba langzeitlagergebuehr',
    ],
    'Subscription': [
        'subscription',
        'abonnement',
        'gebuehr fuer verkaeuferkonto',
    ],
    'Failed disbursement': [
        'failed disbursement',
        'fehlgeschlagene auszahlung',
    ],
    'Micro Deposit': [
        'micro deposit',
        'micro-einzahlung',
        'kleineinzahlung',
    ],
    'Other': ['other', 'andere'],
}


# ─── Pending DE description mappings ─────────────────────────────────────────
#
# This dict is intentionally empty for now. As more German (DE) payment report
# samples are collected, unmapped German description values will be logged by
# normalize_payment_description() via the "[DE Mapping Monitor]" logger.
#
# To add a new mapping:
#   1. Check logs for "[DE Mapping Monitor] Unknown German system description"
#   2. Identify the canonical English description it should map to
#   3. Add the German variant(s) to PAYMENT_DESCRIPTION_ALIASES (preferred)
#      or here if the mapping is uncertain and needs review
#
# Example:
#   "Some German Description": "notes about which English canonical it maps to",
#
PAYMENT_DESCRIPTION_ALIASES_PENDING_DE = {
}


def _normalize_payment_token(value: str) -> str:
    return ' '.join(
        str(value)
        .strip()
        .strip('"')
        .lower()
        .replace('\ufeff', '')
        .replace('ä', 'ae')
        .replace('ö', 'oe')
        .replace('ü', 'ue')
        .replace('ß', 'ss')
        .split()
    )


# ─── FBA 仓储费 vs 派送费拆分 ──────────────────────────────────────
#
# Amazon 结算 CSV 把**仓储费**也写成 ``type = "FBA Transaction fees"``，只有
# ``description`` 才说明它其实是仓储费，例如::
#
#   type="FBA Transaction fees", description="FBA Inventory Storage Fee"
#   type="FBA Transaction fees", description="FBA Long Term Storage Fee"
#
# 这些属于月报汇总行 *FBA inventory and inbound service fees*
# （中文：FBA 库存和入库服务费），**不**属于 *FBA transaction fees*
# （FBA 派送费）—— 后者是 Amazon 已经写在每条 ``Order`` 行 ``fba fees`` 列里的
# 单均履约费。
#
# 旧的取数把两者合进派送费，导致仓储费算进派送费、而库存和入库服务费恒为 0。
# 只能按 description 而不是 ``type`` 拆分，因为两者的 type 完全相同。
#
# 规则（已与业务核对）：``FBA Transaction Fees`` 类型下**只有仓储类**算库存及其入库
# 服务费——含 storage（月度 / 长期 / DE ``Lagergebühr``）。其余全部留在派送费，
# 包括 ``FBA Inbound Placement Service Fee``（入库配置服务费）、
# ``FBA Inbound Transportation Fee``、weight-based fee、removal / disposal 等。
# 注意：inbound placement 虽名义上属入库，但按业务口径归派送费，故**不**在关键词里。
FBA_STORAGE_FEE_DESCRIPTION_KEYWORDS = (
    'storage fee',
    'lagergebuehr',
    'inventory storage',
)


def is_fba_storage_fee(description: Any) -> bool:
    """Whether an ``FBA Transaction Fees`` row is a storage (仓储) fee.

    Accepts the raw or already-normalized description. Matching is done on the
    umlaut-folded, lower-cased token form so it works for US (``FBA Inventory
    Storage Fee``) and DE (``FBA Lagergebühr``) rows alike.

    Rows under ``FBA Transaction Fees`` that this returns ``False`` for stay in
    the 派送费 bucket — that includes ``FBA Inbound Placement Service Fee`` /
    ``FBA Inbound Transportation Fee``, per the agreed business rule.

    Args:
        description: Raw CSV description cell (``None`` / empty is allowed).

    Returns:
        ``True`` when the description indicates a storage fee.
    """
    if description is None:
        return False
    normalized = _normalize_payment_token(str(description))
    if not normalized:
        return False
    return any(
        keyword in normalized for keyword in FBA_STORAGE_FEE_DESCRIPTION_KEYWORDS
    )


def _match_payment_columns(columns: list[str], fallback_locale: str) -> tuple[dict[str, str], str] | None:
    normalized_columns = {_normalize_payment_token(column): column for column in columns}
    mapped: dict[str, str] = {}

    for standard_name, aliases in PAYMENT_REPORT_COLUMN_ALIASES.items():
        for alias in aliases:
            source_name = normalized_columns.get(_normalize_payment_token(alias))
            if source_name:
                mapped[standard_name] = source_name
                break

    if PAYMENT_REPORT_REQUIRED_COLUMNS - set(mapped.keys()):
        return None

    detected_locale = fallback_locale
    return mapped, detected_locale


def is_payment_report_by_columns(path: Path) -> bool:
    """Check if the file looks like a payment report by matching column names.

    Scans the first 15 lines, trying each line as a potential header row.
    Uses PAYMENT_REPORT_COLUMN_ALIASES to match columns (supports US/DE locale).
    A line is considered a header if at least 3 of its first 5 columns match
    known payment report column aliases.
    """
    raw_bytes = path.read_bytes()
    decoded_text = None
    for encoding in ('utf-8-sig', 'utf-8', 'utf-16', 'utf-16le', 'utf-16be'):
        try:
            decoded_text = raw_bytes.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if decoded_text is None:
        decoded_text = raw_bytes.decode('latin1', errors='replace')

    lines = decoded_text.splitlines()[:15]

    canonical_columns = ['date/time', 'settlement id', 'type', 'order id', 'sku']
    expected_aliases: set[str] = set()
    for col in canonical_columns:
        if col in PAYMENT_REPORT_COLUMN_ALIASES:
            for alias in PAYMENT_REPORT_COLUMN_ALIASES[col]:
                expected_aliases.add(_normalize_payment_token(alias))

    for line in lines:
        for delimiter in (',', '\t', ';'):
            columns = [part.strip().strip('"') for part in line.split(delimiter)]
            if len(columns) < 3:
                continue

            normalized_columns = [_normalize_payment_token(column) for column in columns[:5]]

            matches = sum(1 for col in normalized_columns if col in expected_aliases)
            if matches >= 3:
                return True

    return False


def detect_payment_report_structure(path: Path, *, country: str = 'US') -> PaymentReportStructure:
    normalized_country = normalize_country(country)
    fallback_locale = COUNTRY_TO_LOCALE.get(normalized_country, 'en')

    raw_bytes = path.read_bytes()
    decoded_text = None
    for encoding in ('utf-8-sig', 'utf-8', 'utf-16', 'utf-16le', 'utf-16be'):
        try:
            decoded_text = raw_bytes.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if decoded_text is None:
        decoded_text = raw_bytes.decode('latin1')

    for line_no, raw_line in enumerate(decoded_text.splitlines()):
        line = raw_line.strip()
        if not line:
            continue
        for delimiter in (',', '\t', ';'):
            columns = [part.strip().strip('"') for part in raw_line.split(delimiter)]
            matched = _match_payment_columns(columns, fallback_locale)
            if matched is not None:
                column_mapping, locale = matched
                return PaymentReportStructure(skiprows=line_no, delimiter=delimiter, column_mapping=column_mapping, locale=locale)
    raise ValueError('Payment report missing required columns in header row')


def parse_localized_number(value: Any, locale: str) -> float:
    import pandas as pd

    if value is None or (isinstance(value, float) and pd.isna(value)):
        return 0.0
    text = str(value).strip()
    if not text or text.lower() in {'nan', 'none', 'null'}:
        return 0.0

    negative = text.startswith('(') and text.endswith(')')
    cleaned = ''.join(ch for ch in text if ch.isdigit() or ch in {',', '.', '-'})
    if not cleaned or cleaned in {'-', ',', '.', '-.', '-,'}:
        return 0.0

    if locale == 'de':
        cleaned = cleaned.replace('.', '').replace(',', '.')
    elif ',' in cleaned:
        cleaned = cleaned.replace(',', '')

    number = float(cleaned)
    return -number if negative and number > 0 else number


def normalize_payment_type(value: Any) -> str:
    normalized = _normalize_payment_token(str(value or ''))
    for canonical, aliases in PAYMENT_TYPE_ALIASES.items():
        normalized_aliases = {_normalize_payment_token(alias) for alias in aliases}
        if normalized in normalized_aliases:
            return canonical
    return str(value or '').strip()


def normalize_payment_description(value: Any, locale: str = 'en') -> str:
    import logging
    logger = logging.getLogger(__name__)

    original_value = str(value or '').strip()
    normalized = _normalize_payment_token(original_value)
    # BEL-XXX: Amazon DE exports occasionally contain internal double spaces
    # (e.g. "Versand durch Amazon Erstattung für Lagerbestand -  Allgemeine
    # Anpassung" — two spaces around the dash). Collapse internal whitespace
    # so the exact-match check below can hit either the canonical alias or a
    # future DE long-string alias we add. Without this, every double-space
    # variant silently falls through and returns the raw German string,
    # which then mismatches classifier.adjustment_expense_descriptions and
    # leaks into adjustment_income.
    normalized = ' '.join(normalized.split())

    for canonical, aliases in PAYMENT_DESCRIPTION_ALIASES.items():
        normalized_canonical = ' '.join(_normalize_payment_token(canonical).split())
        if normalized == normalized_canonical:
            return canonical
        normalized_aliases = {
            ' '.join(_normalize_payment_token(alias).split())
            for alias in aliases if alias
        }
        if normalized in normalized_aliases:
            return canonical

    if normalized.startswith('price discount'):
        return 'Price Discount'

    if 'coupon redemption fee' in normalized:
        return 'Coupon Redemption Fee'

    if 'fba customer returns fee' in normalized:
        return 'FBA Customer Returns Fee'

    if 'to your account ending in' in normalized:
        return 'Transfer to Bank Account'

    if 'retrocharge' in normalized:
        if 'reversal' in normalized:
            return 'Retrocharge Reversal'
        return 'Retrocharge'

    if 'fba inventory reimbursement' in normalized:
        if 'customer return' in normalized:
            return 'FBA Inventory Reimbursement - Customer Return'
        elif 'customer service issue' in normalized:
            return 'FBA Inventory Reimbursement - Customer Service Issue'
        elif 'damaged' in normalized:
            return 'FBA Inventory Reimbursement - Damaged'
        elif 'lost:inbound' in normalized or 'lost:warehouse' in normalized:
            return 'FBA Inventory Reimbursement - Lost'
        return 'FBA Inventory Reimbursement'

    if locale == 'de' and original_value:
        for canonical, note in PAYMENT_DESCRIPTION_ALIASES_PENDING_DE.items():
            canonical_normalized = _normalize_payment_token(canonical)
            if (canonical_normalized in normalized or
                normalized in canonical_normalized):
                logger.warning(
                    f"[DE Mapping Monitor] Potential unmapped German description detected: "
                    f"'{original_value}' (similar to '{canonical}'). "
                    f"Expected pattern: {note}. "
                    f"Consider adding to PAYMENT_DESCRIPTION_ALIASES."
                )
                return canonical

        is_likely_product_name = (
            len(original_value) > 50 or
            any(term in normalized for term in [
                'dog', 'blanket', 'grill', 'drill', 'bottle', 'autoclave',
                'heating', 'electric', 'propane', 'battery', 'charger'
            ])
        )

        if not is_likely_product_name:
            # BEL-2026-06-17 follow-up: downgraded from INFO to DEBUG. These
            # "Unknown German description" lines flooded the uvicorn log on
            # every DE monthly report (Amazon emits internal settlement-group
            # IDs like `amzn1.cam.v1.sgid.*` that we never canonicalize).
            # The "Potential unmapped" warning above (line 395) stays at
            # WARNING because it is a genuine fuzzy-match signal worth
            # alerting on; this one is observational only.
            logger.debug(
                f"[DE Mapping Monitor] Unknown German system description: "
                f"'{original_value}' (normalized: '{normalized}'). "
                f"If this is a standard Amazon description, consider adding to mapping."
            )

    return original_value


def read_payment_report_dataframe(path: Path, *, country: str = 'US') -> pd.DataFrame:
    import pandas as pd

    structure = detect_payment_report_structure(path, country=country)
    raw_bytes = path.read_bytes()

    decoded_text = None
    for encoding in ('utf-8-sig', 'utf-8', 'utf-16', 'utf-16le', 'utf-16be'):
        try:
            decoded_text = raw_bytes.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if decoded_text is None:
        decoded_text = raw_bytes.decode('latin1')

    lines = decoded_text.splitlines()
    if structure.skiprows >= len(lines):
        raise ValueError('Payment report header row not found')

    stream = io.StringIO('\n'.join(lines[structure.skiprows:]))
    reader = csv.DictReader(stream, delimiter=structure.delimiter)
    records: list[dict[str, Any]] = []

    for row in reader:
        if not isinstance(row, dict):
            continue

        mapped: dict[str, Any] = {}
        for canonical_name, source_name in structure.column_mapping.items():
            raw_value = row.get(source_name)
            mapped[canonical_name] = raw_value.strip() if isinstance(raw_value, str) else raw_value

        if not any((str(value).strip() if value is not None else '') for value in mapped.values()):
            continue

        for key in PAYMENT_NUMERIC_COLUMNS:
            if key in mapped:
                mapped[key] = parse_localized_number(mapped.get(key), structure.locale)

        mapped['type'] = normalize_payment_type(mapped.get('type'))
        mapped['sku'] = str(mapped.get('sku') or '').strip()

        if 'description' in mapped:
            mapped['description'] = normalize_payment_description(
                mapped.get('description'),
                structure.locale
            )

        records.append(mapped)

    if not records:
        return pd.DataFrame(columns=sorted(PAYMENT_REPORT_REQUIRED_COLUMNS))

    df = pd.DataFrame.from_records(records)
    required_missing = [col for col in PAYMENT_REPORT_REQUIRED_COLUMNS if col not in df.columns]
    if required_missing:
        raise ValueError(f'Payment report missing required columns: {required_missing}')
    return df


__all__ = [
    "PAYMENT_REPORT_HEADER_MARKERS",
    "PAYMENT_REPORT_COLUMN_ALIASES",
    "PAYMENT_REPORT_REQUIRED_COLUMNS",
    "PAYMENT_NUMERIC_COLUMNS",
    "PAYMENT_TYPE_ALIASES",
    "PAYMENT_DESCRIPTION_ALIASES",
    "FBA_STORAGE_FEE_DESCRIPTION_KEYWORDS",
    "PaymentReportStructure",
    "_normalize_payment_token",
    "is_fba_storage_fee",
    "_match_payment_columns",
    "is_payment_report_by_columns",
    "detect_payment_report_structure",
    "parse_localized_number",
    "normalize_payment_type",
    "normalize_payment_description",
    "read_payment_report_dataframe",
]
