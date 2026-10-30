package api

import (
	"context"
	"net/http"
	"testing"
)

func TestGatewayConnectionProbesPublicHealthEndpointWithoutCredentials(t *testing.T) {
	httpClient := stubHTTPClient{fn: func(req *http.Request) (*http.Response, error) {
		if req.Method != http.MethodGet || req.URL.String() != "https://gateway.example.test/api/v1/health/live" {
			t.Errorf("request = %s %s", req.Method, req.URL)
		}
		if got := req.Header.Get("X-API-Key"); got != "" {
			t.Errorf("X-API-Key = %q, want empty", got)
		}
		return jsonResponse(http.StatusOK, `{
			"status":"ok",
			"timestamp":1
		}`), nil
	}}

	info, err := testGatewayConnection(
		context.Background(),
		" https://gateway.example.test/ ",
		httpClient,
	)
	if err != nil {
		t.Fatal(err)
	}
	if info.BaseURL != "https://gateway.example.test" {
		t.Errorf("BaseURL = %q", info.BaseURL)
	}
	if info.Status != "ok" || info.Version != "" {
		t.Errorf("connection info = %#v", info)
	}
}

func TestGatewayConnectionRejectsInvalidURLBeforeRequest(t *testing.T) {
	called := false
	_, err := testGatewayConnection(context.Background(), "file:///tmp/gateway", stubHTTPClient{
		fn: func(*http.Request) (*http.Response, error) {
			called = true
			return nil, nil
		},
	})
	if err == nil {
		t.Fatal("expected invalid URL error")
	}
	if called {
		t.Error("invalid URL reached the HTTP client")
	}
}
