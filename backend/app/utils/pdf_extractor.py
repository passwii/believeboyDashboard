import re
from typing import Dict, List, Any, Optional
import pdfplumber


def parse_number(value_str: str, country: str = "US") -> float:
    """Parse number from string based on country format.

    European countries (DE, FR, IT, ES, NL, BE, etc.):
        Thousand separator: '.' (dot)
        Decimal separator: ',' (comma)
        e.g., "25.309,50" → 25309.50

    US and other countries (US, UK, JP, CA, MX, AU, IN, BR, SE, PL, TR, SG, AE, SA):
        Thousand separator: ',' (comma)
        Decimal separator: '.' (dot)
        e.g., "25,309.50" → 25309.50
    """
    # European countries use dot as thousand separator and comma as decimal
    EUROPEAN_COUNTRIES = {"DE", "FR", "IT", "ES", "NL", "BE", "AT", "CH", "PT", "IE", "FI", "GR", "LU"}

    value_str = value_str.strip()
    value_str = value_str.replace(" ", "")
    if value_str.startswith("-"):
        negative = True
        value_str = value_str[1:]
    else:
        negative = False

    if country.upper() in EUROPEAN_COUNTRIES:
        # European format: dot=thousand, comma=decimal
        # e.g., "25.309,50" → "25309.50"
        value_str = value_str.replace(".", "").replace(",", ".")
    else:
        # US format: comma=thousand, dot=decimal
        # e.g., "25,309.50" → "25309.50"
        value_str = value_str.replace(",", "")

    try:
        result = float(value_str)
        return -result if negative else result
    except ValueError:
        return 0.0


class PDFExtractor:
    def __init__(self, pdf_path: str, country: str = "US"):
        self.pdf_path = pdf_path
        self.country = country.upper()

    def extract_text(self) -> str:
        with pdfplumber.open(self.pdf_path) as pdf:
            return "\n".join(page.extract_text() or "" for page in pdf.pages)

    def extract_tables(self) -> List[List[List[str]]]:
        with pdfplumber.open(self.pdf_path) as pdf:
            return [page.extract_tables() or [] for page in pdf.pages]

    def extract_all_tables_flat(self) -> List[List[str]]:
        all_rows = []
        with pdfplumber.open(self.pdf_path) as pdf:
            for page in pdf.pages:
                tables = page.extract_tables()
                for table in tables:
                    for row in table:
                        if row:
                            all_rows.append(row)
        return all_rows

    def extract_summary_data(self) -> Dict[str, Any]:
        text = self.extract_text()
        tables = self.extract_all_tables_flat()
        return {
            "text": text,
            "tables": tables,
        }

    def extract_key_values(self) -> Dict[str, float]:
        text = self.extract_text()

        mapping = {
            "FBA_product_sales": [
                r"Verkäufe mit Versand durch Amazon\s+([\d\s.,]+)",
                r"Verkäufe, die durch Verkäufer selbst verschickt wurden\s+([\d\s.,]+)",
                r"FBA product sales\s+([\d\s.,]+)",
                r"Product Sales\s+([\d\s.,]+)",
            ],
            "FBA_product_sale_refunds": [
                r"Erstattungen für durch Amazon versandte Artikel\s+(-?[\d\s.,]+)",
                r"Erstattungen für vom Verkäufer versandte Artikel\s+(-?[\d\s.,]+)",
                r"FBA product sale refunds\s+(-?[\d\s.,]+)",
            ],
            "FBA_selling_fees": [
                r"Verkaufsgebühren Versand durch Amazon\s+(-?[\d\s.,]+)",
                r"FBA selling fees\s+(-?[\d\s.,]+)",
            ],
            "FBA_transaction_fees": [
                r"Transaktionsgebühren Versand durch Amazon\s+(-?[\d\s.,]+)",
                r"FBA transaction fees\s+(-?[\d\s.,]+)",
            ],
            "FBA_inventory_and_inbound_services": [
                r"Lagerbestands- und Service-Gebühren für Versand durch Amazon\s+(-?[\d\s.,]+)",
                r"FBA inventory and inbound services fees\s+(-?[\d\s.,]+)",
            ],
            "service_fees": [
                r"Servicegebühren\s+(-?[\d\s.,]+)",
                r"Service fees\s+(-?[\d\s.,]+)",
            ],
            "advertising_costs": [
                r"Werbekosten\s+(-?[\d\s.,]+)",
                r"Cost of Advertising\s+(-?[\d\s.,]+)",
            ],
            "total_income": [
                r"Einnahmen\s+Umsätze, Einnahmen und Erstattungen\s+([\d\s.,]+)",
                r"Gesamt\s*Einnahmen\s+([\d\s.,]+)",
                r"Total\s+Income\s+([\d\s.,]+)",
                r"Income\s+([\d\s.,]+)",
                r"Total\s+Revenue\s+([\d\s.,]+)",
            ],
            "total_expense": [
                r"Ausgaben\s+Gebühren, einschließlich.*?\s+(-?[\d\s.,]+)",
                r"Gesamt\s+Ausgaben\s+(-?[\d\s.,]+)",
                r"Total\s+Expenses\s+(-?[\d\s.,]+)",
                r"Expenses\s+(-?[\d\s.,]+)",
            ],
        }

        results = {}
        for key, patterns in mapping.items():
            for pattern in patterns:
                match = re.search(pattern, text, re.IGNORECASE)
                if match:
                    value_str = match.group(1)
                    results[key] = parse_number(value_str, self.country)
                    break
                match = re.search(
                    rf"{re.escape(key.replace('_', ' '))}\s+(-?[\d\s.,]+)", text, re.IGNORECASE
                )
                if match:
                    value_str = match.group(1)
                    results[key] = parse_number(value_str, self.country)
                    break

        return results

    def get_raw_data(self) -> Dict[str, Any]:
        text = self.extract_text()
        key_values = self.extract_key_values()

        return {
            "full_text": text,
            "key_values": key_values,
        }