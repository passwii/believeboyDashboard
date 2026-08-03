"""Unit tests for ``app.utils.marketplace_url.build_marketplace_url``."""

from app.utils.marketplace_url import (
    MARKETPLACE_DOMAINS,
    build_marketplace_url,
)


class TestHappyPath:
    """Known (country, asin) pairs produce ``https://<host>/dp/<asin>``."""

    def test_us(self):
        assert (
            build_marketplace_url("US", "B0DRV1KJTF")
            == "https://www.amazon.com/dp/B0DRV1KJTF"
        )

    def test_uk(self):
        assert (
            build_marketplace_url("UK", "B0ABCDEFGH")
            == "https://www.amazon.co.uk/dp/B0ABCDEFGH"
        )

    def test_de(self):
        assert (
            build_marketplace_url("DE", "B0ABCDEFGH")
            == "https://www.amazon.de/dp/B0ABCDEFGH"
        )

    def test_jp(self):
        assert (
            build_marketplace_url("JP", "B0ABCDEFGH")
            == "https://www.amazon.co.jp/dp/B0ABCDEFGH"
        )

    def test_mx(self):
        assert (
            build_marketplace_url("MX", "B0ABCDEFGH")
            == "https://www.amazon.com.mx/dp/B0ABCDEFGH"
        )

    def test_all_documented_sites_present(self):
        """Every Amazon site we currently sell in must map to a host."""
        # If you add a new country to SUPPORTED_COUNTRIES in
        # app.utils.country, mirror it here.
        expected = {"US", "UK", "DE", "FR", "IT", "ES", "JP", "CA", "MX"}
        assert set(MARKETPLACE_DOMAINS.keys()) >= expected


class TestCaseInsensitive:
    """Country codes are normalised to upper-case before lookup."""

    def test_lowercase_us(self):
        assert (
            build_marketplace_url("us", "B0DRV1KJTF")
            == "https://www.amazon.com/dp/B0DRV1KJTF"
        )

    def test_lowercase_de(self):
        assert (
            build_marketplace_url("de", "B0ABCDEFGH")
            == "https://www.amazon.de/dp/B0ABCDEFGH"
        )

    def test_mixed_case(self):
        assert (
            build_marketplace_url("Uk", "B0ABCDEFGH")
            == "https://www.amazon.co.uk/dp/B0ABCDEFGH"
        )

    def test_whitespace_is_stripped(self):
        assert (
            build_marketplace_url("  US  ", "B0DRV1KJTF")
            == "https://www.amazon.com/dp/B0DRV1KJTF"
        )


class TestNullAndEmpty:
    """Empty / whitespace inputs return ``None`` rather than raising."""

    def test_empty_country(self):
        assert build_marketplace_url("", "B0DRV1KJTF") is None

    def test_whitespace_country(self):
        assert build_marketplace_url("   ", "B0DRV1KJTF") is None

    def test_none_country(self):
        assert build_marketplace_url(None, "B0DRV1KJTF") is None

    def test_empty_asin(self):
        assert build_marketplace_url("US", "") is None

    def test_whitespace_asin(self):
        assert build_marketplace_url("US", "   ") is None

    def test_none_asin(self):
        assert build_marketplace_url("US", None) is None

    def test_both_none(self):
        assert build_marketplace_url(None, None) is None


class TestUnknownCountry:
    """Unknown ISO-2 codes return ``None`` (no fake host, no exception)."""

    def test_unknown_returns_none(self):
        assert build_marketplace_url("ZZ", "B0DRV1KJTF") is None

    def test_lowercase_unknown_returns_none(self):
        # Lookup happens after upper-casing; "zz" → "ZZ" → not in dict.
        assert build_marketplace_url("zz", "B0DRV1KJTF") is None


class TestAsinPassthrough:
    """ASIN is taken as-is (whitespace-stripped) — no normalisation.

    Amazon ASINs are 10-char uppercase alphanumerics. We deliberately do
    not validate / uppercase here: the storage layer enforces shape, and
    we'd rather pass through (and let the URL misbehave visibly) than
    silently rewrite user data.
    """

    def test_lowercase_asin_passes_through(self):
        # Documented behaviour: we do not mutate the ASIN.
        assert (
            build_marketplace_url("US", "b0drv1kjtf")
            == "https://www.amazon.com/dp/b0drv1kjtf"
        )

    def test_asin_whitespace_stripped(self):
        # Whitespace around the ASIN is stripped (to defend against
        # accidental spaces from copy/paste in upstream data).
        assert (
            build_marketplace_url("US", "  B0DRV1KJTF  ")
            == "https://www.amazon.com/dp/B0DRV1KJTF"
        )
