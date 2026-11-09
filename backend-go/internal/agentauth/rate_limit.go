package agentauth

import (
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type RateLimit struct {
	Requests int
	Window   time.Duration
}

func ParseRateLimit(spec string) (RateLimit, error) {
	amountText, windowText, found := strings.Cut(strings.TrimSpace(spec), "/")
	if !found {
		return RateLimit{}, fmt.Errorf("invalid rate limit %q", spec)
	}
	requests, err := strconv.Atoi(strings.TrimSpace(amountText))
	if err != nil || requests <= 0 {
		return RateLimit{}, fmt.Errorf("invalid rate limit count %q", amountText)
	}

	var window time.Duration
	switch strings.ToLower(strings.TrimSpace(windowText)) {
	case "second", "seconds":
		window = time.Second
	case "minute", "minutes":
		window = time.Minute
	case "hour", "hours":
		window = time.Hour
	case "day", "days":
		window = 24 * time.Hour
	default:
		return RateLimit{}, fmt.Errorf("invalid rate limit window %q", windowText)
	}
	return RateLimit{Requests: requests, Window: window}, nil
}

type RateLimitDecision struct {
	Allowed    bool
	Limit      int
	Remaining  int
	RetryAfter time.Duration
	ResetAt    time.Time
}

type RateLimiter interface {
	Allow(key string) RateLimitDecision
}

type MemoryRateLimiter struct {
	mu      sync.Mutex
	limit   RateLimit
	buckets map[string]rateLimitBucket
	now     func() time.Time
}

type rateLimitBucket struct {
	windowStartedAt time.Time
	count           int
}

type MemoryRateLimiterOption func(*MemoryRateLimiter)

func WithMemoryRateLimitClock(now func() time.Time) MemoryRateLimiterOption {
	return func(limiter *MemoryRateLimiter) {
		if now != nil {
			limiter.now = now
		}
	}
}

func NewMemoryRateLimiter(limit RateLimit, options ...MemoryRateLimiterOption) *MemoryRateLimiter {
	limiter := &MemoryRateLimiter{
		limit:   limit,
		buckets: make(map[string]rateLimitBucket),
		now:     time.Now,
	}
	for _, option := range options {
		if option != nil {
			option(limiter)
		}
	}
	return limiter
}

func (l *MemoryRateLimiter) Allow(key string) RateLimitDecision {
	now := l.now()
	if l.limit.Requests <= 0 || l.limit.Window <= 0 {
		return RateLimitDecision{
			Allowed:    false,
			RetryAfter: time.Second,
			ResetAt:    now.Add(time.Second),
		}
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	bucket := l.buckets[key]
	if bucket.windowStartedAt.IsZero() ||
		!now.Before(bucket.windowStartedAt.Add(l.limit.Window)) {
		bucket = rateLimitBucket{windowStartedAt: now}
	}

	resetAt := bucket.windowStartedAt.Add(l.limit.Window)
	if bucket.count >= l.limit.Requests {
		retryAfter := resetAt.Sub(now)
		if retryAfter < 0 {
			retryAfter = 0
		}
		l.buckets[key] = bucket
		return RateLimitDecision{
			Allowed:    false,
			Limit:      l.limit.Requests,
			Remaining:  0,
			RetryAfter: retryAfter,
			ResetAt:    resetAt,
		}
	}

	bucket.count++
	l.buckets[key] = bucket
	return RateLimitDecision{
		Allowed:   true,
		Limit:     l.limit.Requests,
		Remaining: l.limit.Requests - bucket.count,
		ResetAt:   resetAt,
	}
}

// RequireRateLimit applies one bucket; callers should use separate instances for read and write.
func RequireRateLimit(limiter RateLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if limiter == nil {
				WriteError(w, http.StatusInternalServerError, ErrorCodeInternalError, DetailInternalError)
				return
			}
			decision := limiter.Allow(rateLimitKey(r))
			if decision.Limit > 0 {
				w.Header().Set("X-RateLimit-Limit", strconv.Itoa(decision.Limit))
				w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(decision.Remaining))
			}
			if !decision.ResetAt.IsZero() {
				w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(decision.ResetAt.Unix(), 10))
			}
			if !decision.Allowed {
				retryAfter := int64((decision.RetryAfter + time.Second - 1) / time.Second)
				if retryAfter < 1 {
					retryAfter = 1
				}
				w.Header().Set("Retry-After", strconv.FormatInt(retryAfter, 10))
				WriteError(
					w,
					http.StatusTooManyRequests,
					ErrorCodeAgentRateLimitExceeded,
					DetailRateLimitExceeded,
				)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func rateLimitKey(r *http.Request) string {
	if credential, ok := CredentialFromRequest(r); ok {
		if agentID := strings.TrimSpace(credential.AgentID); agentID != "" {
			return "agent:" + agentID
		}
	}
	remoteAddr := strings.TrimSpace(r.RemoteAddr)
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		remoteAddr = host
	}
	if remoteAddr == "" {
		return "unknown"
	}
	return "ip:" + remoteAddr
}
