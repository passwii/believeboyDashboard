package main

import (
	"encoding/json"
	"sort"
	"strings"
)

type openAPIDocument struct {
	Paths map[string]map[string]json.RawMessage `json:"paths"`
}

// extractGETRoutes returns every GET path in the OpenAPI document that has no
// path parameters, plus the number of GET routes skipped because they need
// concrete identifiers.
func extractGETRoutes(payload []byte) ([]string, int, error) {
	var document openAPIDocument
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, 0, err
	}

	routes := make([]string, 0, len(document.Paths))
	skipped := 0
	for path, operations := range document.Paths {
		if _, ok := operations["get"]; !ok {
			continue
		}
		if strings.Contains(path, "{") {
			skipped++
			continue
		}
		routes = append(routes, path)
	}
	sort.Strings(routes)
	return routes, skipped, nil
}
