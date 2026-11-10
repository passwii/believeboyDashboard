package main

import "testing"

func TestDynamicSchedulingEnabled(t *testing.T) {
	tests := []struct {
		name        string
		databaseURL string
		want        bool
	}{
		{name: "configured", databaseURL: "postgres://localhost/believeboy", want: true},
		{name: "empty", databaseURL: "", want: false},
		{name: "whitespace only", databaseURL: "   ", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := dynamicSchedulingEnabled(tt.databaseURL); got != tt.want {
				t.Fatalf("dynamicSchedulingEnabled(%q) = %v, want %v", tt.databaseURL, got, tt.want)
			}
		})
	}
}
