package httpserver

import (
	"log/slog"
	"net/http"
	"time"
)

// fallbackStatusRecorder captures the status the upstream FastAPI served while
// preserving streaming behaviour. The wrapped writer must keep implementing
// http.Flusher, otherwise SSE responses proxied from FastAPI would buffer
// instead of flushing.
type fallbackStatusRecorder struct {
	http.ResponseWriter
	status int
}

func (recorder *fallbackStatusRecorder) WriteHeader(status int) {
	if recorder.status == 0 {
		recorder.status = status
	}
	recorder.ResponseWriter.WriteHeader(status)
}

func (recorder *fallbackStatusRecorder) Write(payload []byte) (int, error) {
	if recorder.status == 0 {
		recorder.status = http.StatusOK
	}
	return recorder.ResponseWriter.Write(payload)
}

func (recorder *fallbackStatusRecorder) Flush() {
	if flusher, ok := recorder.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (recorder *fallbackStatusRecorder) Status() int {
	if recorder.status == 0 {
		return http.StatusOK
	}
	return recorder.status
}

// logFallbackToFastAPI records every request that reached the catch-all proxy.
// Local cutover verification uses these entries to prove that owned prefixes no
// longer depend on FastAPI; without them a silent fallback is indistinguishable
// from a Go-served request.
func logFallbackToFastAPI(logger *slog.Logger, next http.Handler) http.Handler {
	logger = loggerOrDefault(logger)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		startedAt := time.Now()
		recorder := &fallbackStatusRecorder{ResponseWriter: w}
		next.ServeHTTP(recorder, r)
		logger.WarnContext(
			r.Context(),
			"request fell back to FastAPI",
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.String("query", r.URL.RawQuery),
			slog.Int("status", recorder.Status()),
			slog.Duration("duration", time.Since(startedAt)),
			slog.String("request_id", RequestIDFromContext(r.Context())),
		)
	})
}
