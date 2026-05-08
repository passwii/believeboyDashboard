from __future__ import annotations

from dataclasses import dataclass
from app.utils.country import COUNTRY_ALIASES, SUPPORTED_COUNTRIES
from pathlib import Path
from typing import Any
import csv
import io

import pandas as pd

PAYMENT_LOCALE_BY_COUNTRY = {
    'US': 'en',
    'DE': 'de',
    'UK': 'en',
}


@dataclass
class PaymentReportStructure:
    skiprows: int
    delimiter: str
    column_mapping: dict[str, str]
    locale: str


PAYMENT_REPORT_COLUMN_ALIASES = {
    # Column name mappings: [English, German, ...other locales]
    # German translations verified from DE-2026AprMonthlyTransaction.csv
    'date/time': ['date/time', 'datum/uhrzeit'],
    'settlement id': ['settlement id', 'abrechnungsnummer'],
    'type': ['type', 'typ'],
    'order id': ['order id', 'bestellnummer'],
    'sku': ['sku', 'sku'],
    'description': ['description', 'beschreibung'],
    'quantity': ['quantity', 'menge'],
    'marketplace': ['marketplace', 'marketplace'],
    'account type': ['account type'],
    'fulfillment': ['fulfillment', 'versand'],
    'order city': ['order city', 'ort der bestellung'],
    'order state': ['order state', 'bundesland'],
    'order postal': ['order postal', 'postleitzahl'],
    'tax collection model': ['tax collection model', 'steuererhebungsmodell'],
    'product sales': ['product sales', 'umsaetze'],  # umsätze
    'product sales tax': ['product sales tax', 'produktumsatzsteuer'],
    'shipping credits': ['shipping credits', 'gutschrift fuer versandkosten'],
    'shipping credits tax': ['shipping credits tax', 'steuer auf versandgutschrift'],
    'gift wrap credits': ['gift wrap credits', 'gutschrift fuer geschenkverpackung'],
    'giftwrap credits tax': ['giftwrap credits tax', 'steuer auf geschenkverpackungsgutschriften'],
    'regulatory fee': ['regulatory fee'],  # Not present in DE reports
    'tax on regulatory fee': ['tax on regulatory fee'],  # Not present in DE reports
    'promotional rebates': ['promotional rebates', 'rabatte aus werbeaktionen'],
    'promotional rebates tax': ['promotional rebates tax', 'steuer auf aktionsrabatte'],
    'marketplace withheld tax': ['marketplace withheld tax', 'einbehaltene steuer auf marketplace'],
    'selling fees': ['selling fees', 'verkaufsgebuehren'],  # verkaufsgebühren
    'fba fees': ['fba fees', 'gebuehren zu versand durch amazon'],
    'other transaction fees': ['other transaction fees', 'andere transaktionsgebuehren'],
    'other': ['other', 'andere'],
    'total': ['total', 'gesamt'],
    # Optional columns (not stored in dedicated DB fields, available in raw_row JSON)
    # These exist in newer US/DE reports but aren't essential for business logic
    'transaction status': ['transaction status', 'transaktionsstatus'],
    'transaction release date': ['transaction release date', 'freigabedatum der transaktion'],
    # Note: German reports don't have these columns:
    # - regulatory fee / tax on regulatory fee
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
    # Type mappings: [English, German, ...other locales]
    # German translations verified from DE CSV samples
    'Order': ['order', 'bestellung'],
    'Refund': ['refund', 'erstattung'],
    'Amazon Fees': ['amazon fees', 'gebuehren von amazon'],
    'Service Fee': ['service fee', 'servicegebuehr'],
    'FBA Inventory Fee': ['fba inventory fee', 'versand durch amazon lagergebuehr'],
    'Transfer': ['transfer', 'uebertrag'],
    'FBA Transaction Fees': ['fba transaction fees'],
    'Chargeback Refund': ['chargeback refund'],
    'Liquidations': ['liquidations'],
    'Adjustment': ['adjustment'],
    'Deal Fee': ['deal fee'],
    'Debt': ['debt'],
    'Fee Adjustment': ['fee adjustment'],
}


# Description field mappings for business logic classification
# Maps localized descriptions to canonical English values used in code logic
PAYMENT_DESCRIPTION_ALIASES = {
    # Advertising related
    'Cost of Advertising': ['cost of advertising', 'werbekosten'],
    'Refund for Advertiser': [
        'refund for advertiser',
        # DE: Not observed yet, using EN as fallback
    ],
    
    # Adjustment related
    'FBA Inventory Reimbursement - General Adjustment': [
        'fba inventory reimbursement - general adjustment',
        # DE: Not observed yet, using EN as fallback
    ],
    'Non-subscription Fee Adjustment': [
        'non-subscription fee adjustment',
        # DE: Not observed yet, using EN as fallback
    ],
    
    # AGL (Amazon Global Logistics) related
    'FBA International Freight Shipping Charge': [
        'fba international freight shipping charge',
        # DE: Not observed yet, using EN as fallback
    ],
    'FBA International Freight Duties and Taxes Charge': [
        'fba international freight duties and taxes charge',
        # DE: Not observed yet, using EN as fallback
    ],
    
    # Fee adjustments
    'Fee Adjustment - Weight and Dimension Change': [
        'fee adjustment - weight and dimension change',
        # DE: Not observed yet, using EN as fallback
    ],
    
    # Deal and Coupon fees
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
    
    # Vine program
    'Vine Enrollment Fee': [
        'vine enrollment fee',
        'vine-registrierungsgebuehr',
    ],
    
    # FBA storage and removal
    'FBA storage fee': [
        'fba storage fee',
        'fba-lagergebuehr',
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
    
    # Other system descriptions
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
    
    # Additional descriptions from PENDING_DE list
    'Refund for Advertiser': [
        'refund for advertiser',
        'werbekosten-erstattung',
        'erstattung werbekosten',
    ],
    'FBA Inventory Reimbursement - General Adjustment': [
        'fba inventory reimbursement - general adjustment',
        'fba-bestandsentschaedigung - allgemeine anpassung',
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
    'Other': ['other', 'andere'],
    
    # Transfer/Disbursement patterns
    # Note: Transfer descriptions vary by account, pattern matching needed
}


# Description aliases that are NOT yet mapped for German locale
# These will use English values as fallback and log warnings
# Format: canonical_name -> expected_pattern_or_note
PAYMENT_DESCRIPTION_ALIASES_PENDING_DE = {
    # All common German descriptions have been mapped.
    # Add new entries here when encountering unmapped German descriptions in production.
}


def normalize_country(value: str | None, *, default: str = 'US') -> str:
    """Public wrapper: accepts an optional default, delegates to shared utility."""
    from app.utils.country import _normalize_country as _nc
    if value is None or (isinstance(value, str) and not value.strip()):
        return default
    return _nc(value)


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


def detect_payment_report_structure(path: Path, *, country: str = 'US') -> PaymentReportStructure:
    normalized_country = normalize_country(country)
    fallback_locale = PAYMENT_LOCALE_BY_COUNTRY.get(normalized_country, 'en')

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
    else:
        if ',' in cleaned and '.' in cleaned:
            cleaned = cleaned.replace(',', '')
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
    """
    Normalize payment description to canonical English value.
    
    This function maps localized descriptions (e.g., German) to the 
    standard English descriptions used in business logic.
    
    For German locale, if a description is not found in the mapping,
    it checks against known pending mappings (PAYMENT_DESCRIPTION_ALIASES_PENDING_DE)
    and logs a warning for monitoring purposes.
    
    Args:
        value: The raw description value from the report
        locale: The locale of the report ('en', 'de', etc.)
    
    Returns:
        Canonical English description or original value if no mapping found
    """
    import logging
    logger = logging.getLogger(__name__)
    
    original_value = str(value or '').strip()
    normalized = _normalize_payment_token(original_value)
    
    # First try exact match in aliases
    for canonical, aliases in PAYMENT_DESCRIPTION_ALIASES.items():
        normalized_aliases = {_normalize_payment_token(alias) for alias in aliases if alias}
        if normalized in normalized_aliases:
            return canonical
    
    # Pattern matching for dynamic descriptions
    # Price Discount patterns: "Price Discount - <uuid>"
    if normalized.startswith('price discount'):
        return 'Price Discount'
    
    # Coupon Redemption patterns: "Coupon Redemption Fee: Save X% on <product>"
    if 'coupon redemption fee' in normalized:
        return 'Coupon Redemption Fee'
    
    # FBA Customer Returns Fee patterns
    if 'fba customer returns fee' in normalized:
        return 'FBA Customer Returns Fee'
    
    # Transfer patterns: "To your account ending in: XXX, Bank Transfer ID: YYY"
    if 'to your account ending in' in normalized:
        return 'Transfer to Bank Account'
    
    # Retrocharge patterns
    if 'retrocharge' in normalized:
        if 'reversal' in normalized:
            return 'Retrocharge Reversal'
        return 'Retrocharge'
    
    # FBA Inventory Reimbursement patterns (various types)
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
    
    # For German locale, check if this is a known pending mapping
    # This helps identify when new German descriptions appear that need mapping
    if locale == 'de' and original_value:
        # Check if this matches any pending DE mapping patterns
        for canonical, note in PAYMENT_DESCRIPTION_ALIASES_PENDING_DE.items():
            canonical_normalized = _normalize_payment_token(canonical)
            # If the description is similar to a pending canonical name,
            # it might be the German version we're looking for
            if (canonical_normalized in normalized or 
                normalized in canonical_normalized):
                logger.warning(
                    f"[DE Mapping Monitor] Potential unmapped German description detected: "
                    f"'{original_value}' (similar to '{canonical}'). "
                    f"Expected pattern: {note}. "
                    f"Consider adding to PAYMENT_DESCRIPTION_ALIASES."
                )
                # Return the canonical English name so business logic still works
                return canonical
        
        # Log unknown German system descriptions (not product names)
        # Product names are typically longer and contain product-specific terms
        is_likely_product_name = (
            len(original_value) > 50 or  # Product names are long
            any(term in normalized for term in [
                'dog', 'blanket', 'grill', 'drill', 'bottle', 'autoclave',
                'heating', 'electric', 'propane', 'battery', 'charger'
            ])
        )
        
        if not is_likely_product_name:
            logger.info(
                f"[DE Mapping Monitor] Unknown German system description: "
                f"'{original_value}' (normalized: '{normalized}'). "
                f"If this is a standard Amazon description, consider adding to mapping."
            )
    
    # Product descriptions (SKU names) - keep as-is
    # These are product titles and don't need normalization
    return original_value


def read_payment_report_dataframe(path: Path, *, country: str = 'US') -> pd.DataFrame:
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
        # Note: This reads ALL columns defined in PAYMENT_REPORT_COLUMN_ALIASES
        # including optional columns like 'transaction status' and 'transaction release date'
        # These optional columns will be included in the DataFrame and stored in raw_row JSON
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
        
        # Normalize description for consistent business logic processing
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
