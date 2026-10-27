package httpapi

import (
	"encoding/json"
	"net/http"
)

// WriteJSON writes compact JSON using FastAPI-compatible response defaults.
func WriteJSON(w http.ResponseWriter, status int, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return err
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, err = w.Write(payload)
	return err
}

func WriteDetail(w http.ResponseWriter, status int, detail string) {
	_ = WriteJSON(w, status, map[string]string{"detail": detail})
}
