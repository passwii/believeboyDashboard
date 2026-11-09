package agentauth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWriteSuccess(t *testing.T) {
	response := httptest.NewRecorder()
	if err := WriteSuccess(response, http.StatusOK, map[string]any{"id": 7}); err != nil {
		t.Fatalf("WriteSuccess returned error: %v", err)
	}
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	var payload struct {
		OK   bool           `json:"ok"`
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !payload.OK || payload.Data["id"] != float64(7) {
		t.Fatalf("payload = %+v", payload)
	}
}

func TestWriteAPIError(t *testing.T) {
	response := httptest.NewRecorder()
	WriteAPIError(response, &APIError{
		Status: http.StatusForbidden,
		Code:   "TEST_CODE",
		Detail: "test_detail",
	})
	assertErrorResponse(t, response, http.StatusForbidden, "TEST_CODE", "test_detail")
}
