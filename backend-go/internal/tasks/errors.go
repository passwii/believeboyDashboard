package tasks

import (
	"errors"
	"fmt"
)

var (
	ErrExecutorNotConfigured   = errors.New("executor not configured")
	ErrDependencyNotConfigured = errors.New("dependency not configured")
	ErrDatabaseNotConfigured   = errors.New("database not configured")
	ErrJobNotFound             = errors.New("job not found")
	ErrUnsupportedJobType      = errors.New("unsupported job_type")
)

func errRequired(field string) error {
	return fmt.Errorf("%s is required", field)
}

func errPositive(field string) error {
	return fmt.Errorf("%s must be positive", field)
}

func errNonNegative(field string) error {
	return fmt.Errorf("%s must not be negative", field)
}

func errInvalid(field, reason string) error {
	return fmt.Errorf("%s %s", field, reason)
}
