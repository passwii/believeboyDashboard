package api

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/passwii/believeboyDashboard/desktop/internal/config"
)

const defaultProbeTimeout = 5 * time.Second

// ConnectionInfo is the public liveness result shown by desktop settings.
type ConnectionInfo struct {
	BaseURL   string
	Status    string
	Timestamp float64
	Version   string
	Latency   time.Duration
}

// TestGatewayConnection checks a gateway before it is saved. Liveness is
// public, so this deliberately does not load or send account credentials.
func TestGatewayConnection(ctx context.Context, rawBaseURL string) (ConnectionInfo, error) {
	return testGatewayConnection(ctx, rawBaseURL, &http.Client{Timeout: defaultProbeTimeout})
}

func testGatewayConnection(
	ctx context.Context,
	rawBaseURL string,
	httpClient HTTPClient,
) (ConnectionInfo, error) {
	if err := ctx.Err(); err != nil {
		return ConnectionInfo{}, err
	}
	baseURL, err := config.NormalizeAPIBaseURL(rawBaseURL)
	if err != nil {
		return ConnectionInfo{}, err
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultProbeTimeout}
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/v1/health/live", nil)
	if err != nil {
		return ConnectionInfo{}, fmt.Errorf("api: create health probe: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	started := time.Now()
	resp, err := httpClient.Do(req)
	if err != nil {
		return ConnectionInfo{}, &NetworkError{Cause: err}
	}
	defer resp.Body.Close()
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return ConnectionInfo{}, decodeHTTPError(resp)
	}
	payload, err := readBoundedResponse(resp.Body)
	if err != nil {
		return ConnectionInfo{}, err
	}
	var health struct {
		Status    string  `json:"status"`
		Timestamp float64 `json:"timestamp"`
	}
	if err := decodeOneJSON(payload, &health); err != nil {
		return ConnectionInfo{}, fmt.Errorf("%w: decode gateway live response: %v", ErrInvalidResponse, err)
	}
	if health.Status == "" {
		return ConnectionInfo{}, fmt.Errorf("%w: gateway live status is empty", ErrInvalidResponse)
	}
	info := ConnectionInfo{
		BaseURL:   baseURL,
		Status:    health.Status,
		Timestamp: health.Timestamp,
		Latency:   time.Since(started),
	}
	return info, nil
}
