// Package tzcheck guarantees that the Go binaries can resolve the IANA time
// zones they use at runtime.
//
// The Go runtime images are alpine without the tzdata package. Without
// `_ "time/tzdata"` (or the alpine tzdata apk) every time.LoadLocation call
// fails — including store.OpenPool's AfterConnect hook, which resolves the
// PostgreSQL TimeZone before a connection joins the pool. That made every
// DB-backed route return 500 while /health/live stayed green (production
// incident on 2026-11-10). Failing fast at boot turns that silent runtime
// failure into an obvious startup error.
package tzcheck

import (
	"fmt"
	"time"

	_ "time/tzdata"
)

// RequiredTimezone is the business timezone used by the database session and by
// the Go stores (see store.configureTimestamptzScanLocation).
const RequiredTimezone = "Asia/Shanghai"

// Ensure returns an error when the binary cannot load the required timezone.
func Ensure() error {
	if _, err := time.LoadLocation(RequiredTimezone); err != nil {
		return fmt.Errorf("timezone data unavailable for %s: %w", RequiredTimezone, err)
	}
	return nil
}
