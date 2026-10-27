package httpapi

import (
	"strconv"
	"time"
)

// Timestamp matches FastAPI/Pydantic's RFC 3339 rendering for database
// timestamptz values: preserve the database session offset, use microsecond
// precision, and render a zero offset as Z.
func Timestamp(value time.Time) string {
	value = value.Truncate(time.Microsecond)
	formatted := value.Format("2006-01-02T15:04:05")
	if value.Nanosecond() != 0 {
		microseconds := value.Nanosecond() / 1000
		formatted += "." + leftPad(strconv.Itoa(microseconds), 6, "0")
	}
	if _, offset := value.Zone(); offset == 0 {
		return formatted + "Z"
	}
	return formatted + value.Format("-07:00")
}

func OptionalTimestamp(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := Timestamp(*value)
	return &formatted
}

func leftPad(value string, width int, fill string) string {
	for len(value) < width {
		value = fill + value
	}
	return value
}
