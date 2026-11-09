package mailer

import (
	"errors"
	"fmt"
	"time"
)

var (
	// ErrNotConfigured is returned before any network call when the API key or
	// required sender configuration is absent.
	ErrNotConfigured = errors.New("mailer: not configured")
	// ErrInvalidMessage is returned for messages that cannot be represented as
	// a safe Resend request.
	ErrInvalidMessage = errors.New("mailer: invalid message")
	// ErrResponseTooLarge is returned when the provider response exceeds the
	// configured body limit.
	ErrResponseTooLarge = errors.New("mailer: response too large")
	// ErrMalformedResponse is returned when a successful response has no usable
	// email ID.
	ErrMalformedResponse = errors.New("mailer: malformed response")
)

// APIError is a bounded, non-secret description of a non-2xx Resend response.
type APIError struct {
	StatusCode int
	Name       string
	Message    string
	RetryAfter time.Duration
}

func (err *APIError) Error() string {
	if err == nil {
		return "mailer: provider error"
	}
	name := err.Name
	if name == "" {
		name = "HTTP error"
	}
	if err.Message == "" {
		return fmt.Sprintf("mailer: resend %s (%d)", name, err.StatusCode)
	}
	return fmt.Sprintf("mailer: resend %s (%d): %s", name, err.StatusCode, err.Message)
}

func invalidMessage(message string) error {
	return fmt.Errorf("%w: %s", ErrInvalidMessage, message)
}
