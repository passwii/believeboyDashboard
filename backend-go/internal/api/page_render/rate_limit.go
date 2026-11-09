package page_render

import (
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type publicRateLimiter struct {
	limit int
	now   func() time.Time

	mu      sync.Mutex
	buckets map[string]rateBucket
}

type rateBucket struct {
	windowStart time.Time
	count       int
}

func newPublicRateLimiter(limit int, now func() time.Time) *publicRateLimiter {
	if limit <= 0 {
		limit = 30
	}
	if now == nil {
		now = time.Now
	}
	return &publicRateLimiter{limit: limit, now: now, buckets: map[string]rateBucket{}}
}

func (limiter *publicRateLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := requestIP(r)
		allowed, remaining, resetAt := limiter.allow(key)
		w.Header().Set("X-RateLimit-Limit", strconv.Itoa(limiter.limit))
		w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(resetAt.Unix(), 10))
		if !allowed {
			httpapi.WriteDetail(w, http.StatusTooManyRequests, "Rate limit exceeded")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (limiter *publicRateLimiter) allow(key string) (bool, int, time.Time) {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	now := limiter.now().UTC()
	bucket, exists := limiter.buckets[key]
	if !exists || now.Sub(bucket.windowStart) >= time.Minute {
		bucket = rateBucket{windowStart: now, count: 0}
	}
	if bucket.count >= limiter.limit {
		limiter.buckets[key] = bucket
		return false, 0, bucket.windowStart.Add(time.Minute)
	}
	remaining := limiter.limit - bucket.count - 1
	bucket.count++
	limiter.buckets[key] = bucket
	if len(limiter.buckets) > 4096 {
		for bucketKey, value := range limiter.buckets {
			if now.Sub(value.windowStart) >= time.Minute {
				delete(limiter.buckets, bucketKey)
			}
		}
	}
	return true, remaining, bucket.windowStart.Add(time.Minute)
}

func requestIP(r *http.Request) string {
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}
