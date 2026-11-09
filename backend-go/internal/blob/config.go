package blob

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	defaultMaxPutBytes      int64 = 50 * 1024 * 1024
	defaultMaxGetBytes      int64 = 100 * 1024 * 1024
	defaultOperationTimeout       = 30 * time.Second
	defaultRetryMaxAttempts       = 3
	defaultPresignExpiry          = time.Hour
	maxPresignExpiry              = 7 * 24 * time.Hour
)

// Config describes an S3-compatible object store. The zero values use the
// safe defaults documented on the fields.
type Config struct {
	EndpointURL     string
	BucketName      string
	AccessKeyID     string
	SecretAccessKey string
	Region          string
	PublicURL       string

	// MaxPutBytes limits caller-declared upload size. Zero uses 50 MiB.
	MaxPutBytes int64
	// MaxGetBytes limits streamed downloads. Zero uses 100 MiB.
	MaxGetBytes int64
	// Timeout bounds each RPC. Zero uses 30 seconds.
	Timeout time.Duration
	// RetryMaxAttempts controls SDK retries. Zero uses three attempts.
	RetryMaxAttempts int
	// HTTPClient is optional. Supplying http.Client from httptest is supported.
	HTTPClient *http.Client
}

type normalizedConfig struct {
	endpointURL      string
	bucketName       string
	accessKeyID      string
	secretAccessKey  string
	region           string
	publicURL        string
	maxPutBytes      int64
	maxGetBytes      int64
	timeout          time.Duration
	retryMaxAttempts int
	httpClient       *http.Client
}

func normalizeConfig(config Config) (normalizedConfig, error) {
	endpointURL, err := validateHTTPBaseURL(config.EndpointURL, "R2 endpoint")
	if err != nil {
		return normalizedConfig{}, err
	}
	bucketName := strings.TrimSpace(config.BucketName)
	if bucketName == "" {
		return normalizedConfig{}, fmt.Errorf("%w: bucket name is required", ErrNotConfigured)
	}
	if strings.ContainsAny(bucketName, "/\\") {
		return normalizedConfig{}, fmt.Errorf("R2 bucket name must not contain path separators")
	}
	accessKeyID := strings.TrimSpace(config.AccessKeyID)
	if accessKeyID == "" {
		return normalizedConfig{}, fmt.Errorf("%w: access key ID is required", ErrNotConfigured)
	}
	secretAccessKey := strings.TrimSpace(config.SecretAccessKey)
	if secretAccessKey == "" {
		return normalizedConfig{}, fmt.Errorf("%w: secret access key is required", ErrNotConfigured)
	}
	region := strings.TrimSpace(config.Region)
	if region == "" {
		region = "auto"
	}

	publicURL := strings.TrimSpace(config.PublicURL)
	if publicURL != "" {
		publicURL, err = validateHTTPBaseURL(publicURL, "R2 public URL")
		if err != nil {
			return normalizedConfig{}, err
		}
	} else {
		publicURL = endpointURL + "/" + url.PathEscape(bucketName)
	}

	maxPutBytes := config.MaxPutBytes
	if maxPutBytes == 0 {
		maxPutBytes = defaultMaxPutBytes
	}
	if maxPutBytes < 0 {
		return normalizedConfig{}, fmt.Errorf("R2 max put bytes must be positive")
	}
	maxGetBytes := config.MaxGetBytes
	if maxGetBytes == 0 {
		maxGetBytes = defaultMaxGetBytes
	}
	if maxGetBytes < 0 {
		return normalizedConfig{}, fmt.Errorf("R2 max get bytes must be positive")
	}
	timeout := config.Timeout
	if timeout == 0 {
		timeout = defaultOperationTimeout
	}
	if timeout < 0 {
		return normalizedConfig{}, fmt.Errorf("R2 timeout must be positive")
	}
	retryMaxAttempts := config.RetryMaxAttempts
	if retryMaxAttempts == 0 {
		retryMaxAttempts = defaultRetryMaxAttempts
	}
	if retryMaxAttempts < 1 {
		return normalizedConfig{}, fmt.Errorf("R2 retry attempts must be at least one")
	}

	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: timeout}
	}

	return normalizedConfig{
		endpointURL:      endpointURL,
		bucketName:       bucketName,
		accessKeyID:      accessKeyID,
		secretAccessKey:  secretAccessKey,
		region:           region,
		publicURL:        publicURL,
		maxPutBytes:      maxPutBytes,
		maxGetBytes:      maxGetBytes,
		timeout:          timeout,
		retryMaxAttempts: retryMaxAttempts,
		httpClient:       httpClient,
	}, nil
}

func validateHTTPBaseURL(rawURL, fieldName string) (string, error) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return "", fmt.Errorf("%s is required", fieldName)
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" {
		return "", fmt.Errorf("%s must be an absolute HTTP URL", fieldName)
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return "", fmt.Errorf("%s must use HTTPS", fieldName)
	}
	if parsed.Scheme == "http" && !isLoopbackHost(parsed.Hostname()) {
		return "", fmt.Errorf("%s must use HTTPS except for loopback tests", fieldName)
	}
	if parsed.User != nil {
		return "", fmt.Errorf("%s must not contain user information", fieldName)
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("%s must not contain a query or fragment", fieldName)
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
