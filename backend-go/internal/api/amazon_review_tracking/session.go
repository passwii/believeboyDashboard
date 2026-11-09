package amazon_review_tracking

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const defaultSessionTTL = 8 * time.Hour

// RedisSessionValidator mirrors FastAPI's validate_session Lua command:
// existence check plus TTL refresh under {prefix}:session:{user}:{session}.
type RedisSessionValidator struct {
	client    *redis.Client
	keyPrefix string
	ttl       time.Duration
}

func NewRedisSessionValidator(
	client *redis.Client,
	keyPrefix string,
	ttl time.Duration,
) *RedisSessionValidator {
	if ttl <= 0 {
		ttl = defaultSessionTTL
	}
	return &RedisSessionValidator{
		client:    client,
		keyPrefix: strings.Trim(strings.TrimSpace(keyPrefix), ":"),
		ttl:       ttl,
	}
}

func (validator *RedisSessionValidator) ValidateSession(
	ctx context.Context,
	userID string,
	sessionID string,
) (bool, error) {
	if validator == nil || validator.client == nil {
		return false, errors.New("session storage is not configured")
	}
	userID = strings.TrimSpace(userID)
	sessionID = strings.TrimSpace(sessionID)
	if userID == "" || sessionID == "" {
		return false, nil
	}
	result, err := validator.client.Eval(
		ctx,
		`if redis.call('EXISTS', KEYS[1]) == 1 then
		   redis.call('EXPIRE', KEYS[1], ARGV[1])
		   return 1
		 end
		 return 0`,
		[]string{validator.sessionKey(userID, sessionID)},
		int(validator.ttl/time.Second),
	).Int64()
	if err != nil {
		return false, err
	}
	return result == 1, nil
}

func (validator *RedisSessionValidator) sessionKey(userID, sessionID string) string {
	prefix := validator.keyPrefix
	if prefix == "" {
		prefix = "bb"
	}
	return fmt.Sprintf("%s:session:%s:%s", prefix, userID, sessionID)
}
