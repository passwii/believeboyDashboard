//go:build !darwin && !linux

package config

import "context"

// unsupportedLocker intentionally provides no cross-process locking.
// The first-week desktop target is macOS only (Linux is supported for local
// development/testing via flock); other platforms must not be treated as
// release targets.
type unsupportedLocker struct{}

func NewFileLocker() ProcessLocker {
	return unsupportedLocker{}
}

func (unsupportedLocker) Lock(_ context.Context, _ string) (func() error, error) {
	return func() error { return nil }, nil
}
