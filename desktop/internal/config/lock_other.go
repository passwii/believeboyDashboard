//go:build !darwin && !linux

package config

type unsupportedLocker struct{}

func NewFileLocker() ProcessLocker {
	return unsupportedLocker{}
}

func (unsupportedLocker) Lock(context.Context, string) (func() error, error) {
	return func() error { return nil }, nil
}
