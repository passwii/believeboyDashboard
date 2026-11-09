package queue

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

// MarshalPayload encodes an Asynq payload as canonical JSON.
func MarshalPayload(payload any) ([]byte, error) {
	if payload == nil {
		return []byte("{}"), nil
	}

	switch value := payload.(type) {
	case json.RawMessage:
		if !json.Valid(value) {
			return nil, fmt.Errorf("encode task payload: invalid JSON")
		}
		return append([]byte(nil), value...), nil
	case []byte:
		if !json.Valid(value) {
			return nil, fmt.Errorf("encode task payload: invalid JSON")
		}
		return append([]byte(nil), value...), nil
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode task payload: %w", err)
	}
	return encoded, nil
}

// DecodePayload decodes a JSON task payload into a typed destination.
// Empty and null payloads are valid no-argument tasks.
func DecodePayload(payload []byte, destination any) error {
	if destination == nil {
		return fmt.Errorf("decode task payload: destination is nil")
	}
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}

	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("decode task payload: %w", err)
	}

	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("decode task payload: trailing JSON value")
		}
		return fmt.Errorf("decode task payload: trailing data: %w", err)
	}
	return nil
}
