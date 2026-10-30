package api

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/passwii/believeboyDashboard/desktop/internal/config"
)

const defaultProbeTimeout = 5 * time.Second

// ConnectionInfo is the public health result shown by desktop settings.
type ConnectionInfo struct {
	BaseURL string
	Status  string
	Version string
	Latency time.Duration
}

// TestGatewayConnection checks a gateway before it is saved. Health is public,
// so this deliberately does not load or send the current account credentials.
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

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/api/v1/health", nil)
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
	var health HealthResponse
	if err := decodeOneJSON(payload, &health); err != nil {
		return ConnectionInfo{}, fmt.Errorf("%w: decode gateway health: %v", ErrInvalidResponse, err)
	}
	if health.Status == "" {
		return ConnectionInfo{}, fmt.Errorf("%w: gateway health status is empty", ErrInvalidResponse)
	}
	info := ConnectionInfo{
		BaseURL: baseURL,
		Status:  health.Status,
		Latency: time.Since(started),
	}
	if health.Version != nil {
		info.Version = *health.Version
	}
	return info, nil
}
