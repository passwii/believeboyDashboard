package api

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
)

type HeaderEncoding string

const (
	HeaderEncodingBase64 HeaderEncoding = "base64"
	HeaderEncodingURL    HeaderEncoding = "url-percent"
)

var ErrUnknownHeaderPolicy = errors.New("api: no identity header policy for endpoint")

type routeHeaderPolicy struct {
	method   string
	path     string
	prefix   bool
	encoding HeaderEncoding
}

// The backend currently has two header-decoding contracts. Keep this table
// explicit so adding an endpoint forces a deliberate choice. Backend follow-up:
// unify auth/me and presence on deps._decode_header_value so URL encoding can
// eventually be removed from the desktop client.
var routeHeaderPolicies = []routeHeaderPolicy{
	{method: http.MethodGet, path: "/api/v1/health", encoding: HeaderEncodingBase64},
	{method: http.MethodGet, path: "/api/v1/health/live", encoding: HeaderEncodingBase64},
	{method: http.MethodGet, path: "/api/v1/health/ready", encoding: HeaderEncodingBase64},
	{method: http.MethodGet, path: "/api/v1/exchange-rates", prefix: true, encoding: HeaderEncodingBase64},
	{method: http.MethodGet, path: "/api/v1/notifications", prefix: true, encoding: HeaderEncodingBase64},
	{method: http.MethodGet, path: "/api/v1/alerts/", prefix: true, encoding: HeaderEncodingBase64},
	{method: http.MethodGet, path: "/api/v1/system-management/profile", encoding: HeaderEncodingBase64},
	{method: http.MethodGet, path: "/api/v1/projects/", prefix: true, encoding: HeaderEncodingBase64},

	// These FastAPI handlers call urllib.parse.unquote directly.
	{method: http.MethodGet, path: "/api/v1/auth/me", encoding: HeaderEncodingURL},
	{method: http.MethodPost, path: "/api/v1/system-management/presence/heartbeat", encoding: HeaderEncodingURL},
	{method: http.MethodGet, path: "/api/v1/system-management/presence", encoding: HeaderEncodingURL},
}

func HeaderPolicyForRoute(method, requestPath string) (HeaderEncoding, error) {
	if parsed, err := url.Parse(requestPath); err == nil && parsed.Path != "" {
		requestPath = parsed.Path
	}
	for _, policy := range routeHeaderPolicies {
		if method != policy.method {
			continue
		}
		if policy.prefix {
			if strings.HasPrefix(requestPath, policy.path) {
				return policy.encoding, nil
			}
			continue
		}
		if requestPath == policy.path {
			return policy.encoding, nil
		}
	}
	return "", ErrUnknownHeaderPolicy
}
