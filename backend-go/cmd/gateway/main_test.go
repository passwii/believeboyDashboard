package main

import (
	"net/http"
	"testing"
)

func TestNewServerUsesConfiguredAddressAndHandler(t *testing.T) {
	handler := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})

	server := newServer("127.0.0.1:8200", handler)

	if server.Addr != "127.0.0.1:8200" {
		t.Errorf("Addr = %q, want %q", server.Addr, "127.0.0.1:8200")
	}
	if server.Handler == nil {
		t.Fatal("Handler = nil, want configured handler")
	}
	if server.ReadHeaderTimeout <= 0 {
		t.Error("ReadHeaderTimeout must be set")
	}
	if server.WriteTimeout != 0 {
		t.Errorf("WriteTimeout = %s, want 0 so SSE streams are not cut off", server.WriteTimeout)
	}
}
