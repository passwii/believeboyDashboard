package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const defaultSessionRedisScanCount = 1000
const defaultSessionTTL = 8 * time.Hour

const validateSessionLua = `
if redis.call('EXISTS', KEYS[1]) == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
    return 1
end
return 0
`

type SessionRedisClient interface {
	Scan(ctx context.Context, cursor uint64, match string, count int64) *redis.ScanCmd
	Del(ctx context.Context, keys ...string) *redis.IntCmd
}

type SessionRedisValidatorClient interface {
	Eval(ctx context.Context, script string, keys []string, args ...any) *redis.Cmd
}

type RedisSessionRevoker struct {
	client SessionRedisClient
	prefix string
}

func NewRedisSessionRevoker(client SessionRedisClient, keyPrefix string) *RedisSessionRevoker {
	if client == nil {
		return nil
	}
	prefix := strings.Trim(strings.TrimSpace(keyPrefix), ":")
	if prefix == "" {
		prefix = "bb"
	}
	return &RedisSessionRevoker{client: client, prefix: prefix}
}

func (revoker *RedisSessionRevoker) DeleteUserSessions(
	ctx context.Context,
	userID string,
) (int, error) {
	if revoker == nil || revoker.client == nil {
		return 0, fmt.Errorf("session redis client is nil")
	}
	if ctx == nil {
		return 0, fmt.Errorf("session revocation context is nil")
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	if strings.TrimSpace(userID) == "" {
		return 0, fmt.Errorf("session user id is empty")
	}
	if strings.ContainsAny(revoker.prefix, "*?[]\\") {
		return 0, fmt.Errorf("session key prefix contains wildcard characters")
	}

	pattern := revoker.prefix + ":session:" + redisGlobEscape(userID) + ":*"
	deleted := 0
	var cursor uint64
	for {
		keys, next, err := revoker.client.Scan(
			ctx,
			cursor,
			pattern,
			defaultSessionRedisScanCount,
		).Result()
		if err != nil {
			return deleted, err
		}
		if len(keys) > 0 {
			count, err := revoker.client.Del(ctx, keys...).Result()
			if err != nil {
				return deleted, err
			}
			deleted += int(count)
		}
		cursor = next
		if cursor == 0 {
			return deleted, nil
		}
	}
}

type RedisSessionValidator struct {
	client SessionRedisValidatorClient
	prefix string
	ttl    time.Duration
}

func NewRedisSessionValidator(
	client SessionRedisValidatorClient,
	keyPrefix string,
	ttl time.Duration,
) *RedisSessionValidator {
	if client == nil {
		return nil
	}
	if ttl <= 0 {
		ttl = defaultSessionTTL
	}
	prefix := strings.Trim(strings.TrimSpace(keyPrefix), ":")
	if prefix == "" {
		prefix = "bb"
	}
	return &RedisSessionValidator{client: client, prefix: prefix, ttl: ttl}
}

func (validator *RedisSessionValidator) ValidateSession(
	ctx context.Context,
	userID string,
	sessionID string,
) (bool, error) {
	if validator == nil || validator.client == nil {
		return false, fmt.Errorf("session redis client is nil")
	}
	if ctx == nil {
		return false, fmt.Errorf("session validation context is nil")
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	userID = strings.TrimSpace(userID)
	sessionID = strings.TrimSpace(sessionID)
	if userID == "" || sessionID == "" {
		return false, nil
	}
	key := validator.prefix + ":session:" + userID + ":" + sessionID
	valid, err := validator.client.Eval(
		ctx,
		validateSessionLua,
		[]string{key},
		int64(validator.ttl.Seconds()),
	).Int64()
	if err != nil {
		return false, err
	}
	return valid == 1, nil
}

func redisGlobEscape(value string) string {
	var builder strings.Builder
	for _, character := range value {
		switch character {
		case '\\', '*', '?', '[', ']':
			builder.WriteByte('\\')
		}
		builder.WriteRune(character)
	}
	return builder.String()
}
