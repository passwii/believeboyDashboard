package api

import (
	"context"
	"errors"
	"time"
)

var ErrInvalidPollInterval = errors.New("api: poll interval must be positive")

// Poll runs fn immediately and then at each interval until fn returns an error
// or the context is canceled. It is suitable for native shell status cards.
func Poll(ctx context.Context, interval time.Duration, fn func(context.Context) error) error {
	if interval <= 0 {
		return ErrInvalidPollInterval
	}
	if fn == nil {
		return errors.New("api: poll function is required")
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := fn(ctx); err != nil {
			return err
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
