package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWriteDetailUsesFastAPIErrorShape(t *testing.T) {
	rec := httptest.NewRecorder()

	WriteDetail(rec, http.StatusUnauthorized, "Not authenticated")

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", got)
	}
	if got := rec.Body.String(); got != `{"detail":"Not authenticated"}` {
		t.Errorf("body = %q, want FastAPI detail shape", got)
	}
}
