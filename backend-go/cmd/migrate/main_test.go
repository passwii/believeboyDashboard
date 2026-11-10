package main

import (
	"net/url"
	"testing"
)

func TestNormalizeDSNConvertsSQLAlchemyURLAndForcesSimpleProtocol(t *testing.T) {
	got, err := normalizeDSN("postgresql+psycopg://user:pass@127.0.0.1:5432/BLF")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme != "postgresql" {
		t.Fatalf("scheme = %q, want postgresql", parsed.Scheme)
	}
	if parsed.Query().Get("default_query_exec_mode") != "simple_protocol" {
		t.Fatalf("simple protocol missing from %q", got)
	}
}

func TestNormalizeDSNPreservesExplicitQueryMode(t *testing.T) {
	got, err := normalizeDSN("postgresql://user@127.0.0.1:5432/BLF?default_query_exec_mode=exec")
	if err != nil {
		t.Fatal(err)
	}
	if got != "postgresql://user@127.0.0.1:5432/BLF?default_query_exec_mode=exec" {
		t.Fatalf("unexpected DSN: %q", got)
	}
}

func TestNormalizeDSNKeywordValueDSN(t *testing.T) {
	got, err := normalizeDSN("host=127.0.0.1 user=damon dbname=BLF")
	if err != nil {
		t.Fatal(err)
	}
	if got != "host=127.0.0.1 user=damon dbname=BLF default_query_exec_mode=simple_protocol" {
		t.Fatalf("unexpected DSN: %q", got)
	}
}
