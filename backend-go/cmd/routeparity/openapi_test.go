package main

import "testing"

func TestExtractAllGETRoutes(t *testing.T) {
	payload := []byte(`{"paths":{"/api/v1/items":{"get":{}},"/api/v1/items/{item_id}":{"get":{}},"/api/v1/items/{item_id}/parts":{"post":{}}}}`)
	parameterless, parameterized, err := extractAllGETRoutes(payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(parameterless) != 1 || parameterless[0] != "/api/v1/items" {
		t.Fatalf("parameterless = %#v", parameterless)
	}
	if len(parameterized) != 1 || parameterized[0] != "/api/v1/items/{item_id}" {
		t.Fatalf("parameterized = %#v", parameterized)
	}
}

func TestSubstitutePathParams(t *testing.T) {
	if got := substitutePathParams("/api/v1/items/{item_id}/parts/{part_id}", "7"); got != "/api/v1/items/7/parts/7" {
		t.Fatalf("substitute = %s", got)
	}
	if got := substitutePathParams("/api/v1/items", "7"); got != "/api/v1/items" {
		t.Fatalf("no params = %s", got)
	}
}
