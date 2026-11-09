package external_retired

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestExternalRetiredReturnsGoneAndSuccessor(t *testing.T) {
	router := chi.NewRouter()
	NewRegistrar().RegisterRoutes(router, passthrough)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/external/orders/123?foo=bar", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusGone {
		t.Fatalf("status = %d, want 410; body = %s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("Link"); got != `</api/v1/agent/orders/123>; rel="successor-version"` {
		t.Errorf("Link = %q", got)
	}
	if !strings.Contains(rec.Body.String(), `"successor":"/api/v1/agent/orders/123"`) ||
		!strings.Contains(rec.Body.String(), `"detail":"`) {
		t.Errorf("body = %s", rec.Body.String())
	}
}

func passthrough(next http.Handler) http.Handler { return next }
