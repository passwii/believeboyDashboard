package main

import (
	"encoding/json"
	"sort"
	"strings"
)

// jsonShape renders a structural signature of a decoded JSON value. Numbers,
// strings and booleans collapse to their type so the parity check compares the
// wire contract (keys and nesting) instead of data that legitimately differs
// between the test database snapshot and a live instance.
func jsonShape(value any) string {
	return shapeOf(value, 0)
}

func shapeOf(value any, depth int) string {
	if depth > 4 {
		return "..."
	}
	switch typed := value.(type) {
	case nil:
		return "null"
	case bool:
		return "bool"
	case float64:
		return "number"
	case string:
		return "string"
	case []any:
		if len(typed) == 0 {
			return "array[]"
		}
		return "array[" + shapeOf(typed[0], depth+1) + "]"
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			parts = append(parts, key+":"+shapeOf(typed[key], depth+1))
		}
		return "{" + strings.Join(parts, ",") + "}"
	default:
		return "unknown"
	}
}

func decodeJSON(body []byte) (any, bool) {
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return nil, false
	}
	return value, true
}
