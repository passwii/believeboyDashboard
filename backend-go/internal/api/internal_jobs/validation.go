package internal_jobs

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const maxBodyBytes = 1 << 20

func decodeJSONBody(w http.ResponseWriter, r *http.Request, destination any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return err
	}
	return nil
}

func normalizeRefreshRequest(
	request ReturnAnalysisRefreshRequest,
	now time.Time,
	location *time.Location,
) (string, int, error) {
	backfillDays := 1
	if request.BackfillDays != nil {
		backfillDays = *request.BackfillDays
	}
	if backfillDays < 1 || backfillDays > 90 {
		return "", 0, errors.New("backfill_days must be between 1 and 90")
	}
	targetDate := now.In(location).AddDate(0, 0, -1).Format("2006-01-02")
	if request.TargetDate != nil {
		trimmed := strings.TrimSpace(*request.TargetDate)
		if trimmed != "" {
			if _, err := time.ParseInLocation("2006-01-02", trimmed, location); err != nil {
				return "", 0, errors.New("target_date must be YYYY-MM-DD")
			}
			targetDate = trimmed
		}
	}
	return targetDate, backfillDays, nil
}

func idempotencyKeyFromRequest(r *http.Request) string {
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key == "" {
		key = strings.TrimSpace(r.Header.Get("X-Idempotency-Key"))
	}
	runes := []rune(key)
	if len(runes) > 64 {
		return string(runes[:64])
	}
	return key
}

func requestFingerprint(value any) string {
	payload, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(payload)
}
