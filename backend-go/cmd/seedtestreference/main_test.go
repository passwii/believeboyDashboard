package main

import "testing"

func TestSeedReferenceDefinitions(t *testing.T) {
	if len(seedCategories) != 9 {
		t.Fatalf("categories = %d, want 9", len(seedCategories))
	}
	if len(seedTemplates) != 2 {
		t.Fatalf("templates = %d, want 2", len(seedTemplates))
	}
	for _, template := range seedTemplates {
		if len(template.Tasks) != 6 {
			t.Fatalf("template %s tasks = %d, want 6", template.Key, len(template.Tasks))
		}
	}
}
