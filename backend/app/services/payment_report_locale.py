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
    'date/time': ['date/time','Datum/Uhrzeit'],
    'settlement id': ['settlement id','Abrechnungsnummer'],
    'type': ['type', 'Typ'],
    'order id': ['order id', 'bestellnummer'],
    'sku': ['sku'],
    'description': ['description', 'beschreibung'],
    'quantity': ['quantity', 'menge'],
    'marketplace': ['marketplace', 'marktplatz'],
    'account type': ['account type', 'kontotyp'],
    'fulfillment': ['fulfillment', 'ausfuehrung', 'ausführung', 'versand'],
    'order city': ['order city', 'stadt'],
    'order state': ['order state', 'bundesland'],
    'order postal': ['order postal', 'postleitzahl'],
    'tax collection model': ['tax collection model', 'steuererhebungsmodell'],
    'product sales': ['product sales', 'umsaetze', 'umsätze'],
    'product sales tax': ['product sales tax', 'umsatzsteuer', 'produktumsatzsteuer'],
    'shipping credits': ['shipping credits', 'gutschrift fuer versandkosten', 'gutschrift für versandkosten'],
    'shipping credits tax': ['shipping credits tax', 'steuer auf versandkosten', 'steuer auf versandgutschrift'],
    'gift wrap credits': ['gift wrap credits', 'geschenkverpackungsgutschriften', 'gutschrift fuer geschenkverpackung', 'gutschrift für geschenkverpackung'],
    'giftwrap credits tax': ['giftwrap credits tax', 'steuer auf geschenkverpackungsgutschriften'],
    'regulatory fee': ['regulatory fee', 'behoerdliche gebuehr', 'behördliche gebühr'],
    'tax on regulatory fee': ['tax on regulatory fee', 'steuer auf behoerdliche gebuehr', 'steuer auf behördliche gebühr'],
    'promotional rebates': ['promotional rebates', 'rabatte aus werbeaktionen'],
    'promotional rebates tax': ['promotional rebates tax', 'steuer auf rabatte aus werbeaktionen', 'steuer auf aktionsrabatte'],
    'marketplace withheld tax': ['marketplace withheld tax', 'vom marktplatz einbehaltene steuer', 'einbehaltene steuer auf marketplace'],
    'selling fees': ['selling fees', 'verkaufsgebuehren', 'verkaufsgebühren'],
    'fba fees': ['fba fees', 'gebuehren zu versand durch amazon', 'gebühren zu versand durch amazon'],
    'other transaction fees': ['other transaction fees', 'sonstige transaktionsgebuehren', 'sonstige transaktionsgebühren', 'andere transaktionsgebuehren', 'andere transaktionsgebühren'],
    'other': ['other', 'andere'],
    'total': ['total', 'gesamt'],
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

    detected_locale = 'de' if any(_normalize_payment_token(col) == 'typ' for col in columns) else fallback_locale
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
        records.append(mapped)

    if not records:
        return pd.DataFrame(columns=sorted(PAYMENT_REPORT_REQUIRED_COLUMNS))

    df = pd.DataFrame.from_records(records)
    required_missing = [col for col in PAYMENT_REPORT_REQUIRED_COLUMNS if col not in df.columns]
    if required_missing:
        raise ValueError(f'Payment report missing required columns: {required_missing}')
    return df
