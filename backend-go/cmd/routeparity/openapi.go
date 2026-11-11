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
	parameterless, parameterized, err := extractAllGETRoutes(payload)
	if err != nil {
		return nil, 0, err
	}
	return parameterless, len(parameterized), nil
}

// extractAllGETRoutes separates parameterless GET paths from templates that
// contain path parameters.
func extractAllGETRoutes(payload []byte) ([]string, []string, error) {
	var document openAPIDocument
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil, nil, err
	}
	parameterless := make([]string, 0, len(document.Paths))
	parameterized := make([]string, 0, len(document.Paths))
	for path, operations := range document.Paths {
		if _, ok := operations["get"]; !ok {
			continue
		}
		if strings.Contains(path, "{") {
			parameterized = append(parameterized, path)
			continue
		}
		parameterless = append(parameterless, path)
	}
	sort.Strings(parameterless)
	sort.Strings(parameterized)
	return parameterless, parameterized, nil
}

// substitutePathParams replaces every {param} segment with the supplied value.
func substitutePathParams(path, value string) string {
	for {
		start := strings.Index(path, "{")
		if start < 0 {
			return path
		}
		end := strings.Index(path[start:], "}")
		if end < 0 {
			return path
		}
		path = path[:start] + value + path[start+end+1:]
	}
}
