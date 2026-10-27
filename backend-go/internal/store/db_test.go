package store

import (
	"context"
	"strings"
	"testing"
)

func TestOpenPoolRejectsInvalidDatabaseURL(t *testing.T) {
	_, err := OpenPool(context.Background(), "not a connection string")
	if err == nil {
		t.Fatal("OpenPool() error = nil, want invalid DATABASE_URL error")
	}
	if !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Errorf("OpenPool() error = %q, want it to mention DATABASE_URL", err)
	}
}
