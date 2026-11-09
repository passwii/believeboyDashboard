package httpapi

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParsePaginationDefaults(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	p := ParsePagination(req, 20, 100)

	if p.Page != 1 {
		t.Errorf("Page = %d, want 1", p.Page)
	}
	if p.PageSize != 20 {
		t.Errorf("PageSize = %d, want 20", p.PageSize)
	}
	if p.Offset != 0 {
		t.Errorf("Offset = %d, want 0", p.Offset)
	}
}

func TestParsePaginationCustomParams(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/test?page=3&page_size=50", nil)
	p := ParsePagination(req, 20, 100)

	if p.Page != 3 {
		t.Errorf("Page = %d, want 3", p.Page)
	}
	if p.PageSize != 50 {
		t.Errorf("PageSize = %d, want 50", p.PageSize)
	}
	if p.Offset != 100 {
		t.Errorf("Offset = %d, want 100", p.Offset)
	}
}

func TestParsePaginationLimitFallbackAndCap(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/test?page=2&limit=500", nil)
	p := ParsePagination(req, 20, 100)

	if p.Page != 2 {
		t.Errorf("Page = %d, want 2", p.Page)
	}
	if p.PageSize != 100 {
		t.Errorf("PageSize = %d, want 100 (capped at max)", p.PageSize)
	}
	if p.Offset != 100 {
		t.Errorf("Offset = %d, want 100", p.Offset)
	}
}

func TestSafeOffsetOverflow(t *testing.T) {
	offset := SafeOffset(math.MaxInt, 50)
	if offset != math.MaxInt {
		t.Errorf("SafeOffset = %d, want MaxInt", offset)
	}
}

func TestNewPaginatedResponseNeverNilItems(t *testing.T) {
	resp := NewPaginatedResponse[string](nil, 0, 1, 20)
	bytes, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("Marshal error: %v", err)
	}
	expected := `{"items":[],"total":0,"page":1,"page_size":20}`
	if string(bytes) != expected {
		t.Errorf("JSON = %s, want %s", string(bytes), expected)
	}
}
