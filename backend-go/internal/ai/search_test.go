package ai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWebSearchRejectsNonHTTPSConfiguration(t *testing.T) {
	searcher := NewTavilySearcher(WebSearchConfig{
		BaseURL:    "http://127.0.0.1:8080",
		APIKey:     "key",
		MaxResults: 5,
		Timeout:    time.Second,
	})
	if searcher.Configured() {
		t.Fatal("HTTP web search base URL must not be configured")
	}
	_, err := searcher.Search(context.Background(), "query", 5)
	if !errors.Is(err, ErrWebSearchNotConfigured) {
		t.Fatalf("Search() error = %v, want ErrWebSearchNotConfigured", err)
	}
}

func TestValidateWebSearchBaseURLRejectsPrivateHosts(t *testing.T) {
	for _, raw := range []string{
		"http://search.example",
		"https://localhost",
		"https://127.0.0.1",
		"https://10.0.0.1",
		"https://user:pass@search.example",
	} {
		if ValidateWebSearchBaseURL(raw) {
			t.Errorf("ValidateWebSearchBaseURL(%q) = true, want false", raw)
		}
	}
	if !ValidateWebSearchBaseURL("https://search.example") {
		t.Fatal("valid HTTPS search URL rejected")
	}
}

func TestTavilySearcherClampsResultsAndBuildsSafeCards(t *testing.T) {
	var gotPayload map[string]any
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/search" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer search-key" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&gotPayload); err != nil {
			t.Errorf("decode payload: %v", err)
		}
		_, _ = io.WriteString(w, `{
		  "answer":"summary",
		  "results":[
		    {"title":"A","url":"https://example.com/a","content":"alpha","score":"0.9"},
		    {"title":"B","url":"https://example.com/b","content":"beta"},
		    {"title":"C","url":"https://example.com/c","content":"gamma"}
		  ]
		}`)
	}))
	t.Cleanup(server.Close)

	searcher := NewTavilySearcher(WebSearchConfig{
		BaseURL:    server.URL,
		APIKey:     "search-key",
		Topic:      "general",
		Depth:      "advanced",
		MaxResults: 3,
		Timeout:    time.Second,
		HTTPClient: server.Client(),
	})
	result, err := searcher.Search(context.Background(), "migration", 10)
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if gotPayload["max_results"] != float64(3) {
		t.Errorf("request max_results = %#v, want config cap 3", gotPayload["max_results"])
	}
	if len(result.Cards) != 3 {
		t.Fatalf("cards = %#v", result.Cards)
	}
	if result.Cards[0].Score == nil || *result.Cards[0].Score != 0.9 {
		t.Errorf("score = %#v", result.Cards[0].Score)
	}
	if !stringsContains(result.Context, "alpha") || stringsContains(result.Context, "http://127.0.0.1") {
		t.Errorf("context = %q", result.Context)
	}
}

func stringsContains(value, substring string) bool {
	for index := 0; index+len(substring) <= len(value); index++ {
		if value[index:index+len(substring)] == substring {
			return true
		}
	}
	return false
}
