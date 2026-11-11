// Command routeparity compares GET responses between a running FastAPI
// instance and the Go gateway for every parameterless GET route in the OpenAPI
// document. Status codes and JSON structure (keys and nesting) must match; data
// values are ignored because the two instances may read different databases.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	defaultOpenAPI   = "frontend/types/api-generated/openapi.json"
	defaultEnvFile   = "backend/.env.test"
	defaultStateDir  = ".local-cutover"
	defaultTimeout   = 10 * time.Second
	defaultWorkers   = 8
	maxBodyBytes     = 4 << 20
	shapePreviewSize = 120
)

type parityRoute struct {
	path        string
	requestPath string
}

type comparison struct {
	path         string
	requestPath  string
	fastStatus   int
	goStatus     int
	fastShape    string
	goShape      string
	problem      string
	fastIsJSON   bool
	goIsJSON     bool
	requestErr   string
	incomparable bool
}

func main() {
	fastapiURL := flag.String("fastapi", "http://127.0.0.1:18100", "FastAPI base URL")
	goURL := flag.String("go", "http://127.0.0.1:18200", "Go gateway base URL")
	openapiPath := flag.String("openapi", defaultOpenAPI, "OpenAPI JSON file (relative paths resolve from the repo root)")
	envFile := flag.String("env-file", defaultEnvFile, "env file providing API_KEY (relative paths resolve from the repo root)")
	userID := flag.String("user-id", "1", "X-User-Id header for user-scoped routes")
	adminHeader := flag.String("admin-header", "true", "X-Is-Admin header value; empty disables (the web proxy injects it from the session)")
	proxySecret := flag.String("proxy-secret", "", "X-Trusted-Proxy-Secret; defaults to the running runbook state")
	stateDir := flag.String("state-dir", defaultStateDir, "localcutover state directory (relative paths resolve from the repo root)")
	limit := flag.Int("limit", 0, "compare at most N routes (0 = all)")
	pathParamID := flag.String("path-param-id", "1", "value substituted for {param} path segments")
	workers := flag.Int("workers", defaultWorkers, "parallel requests")
	timeout := flag.Duration("timeout", defaultTimeout, "per-request timeout")
	flag.Parse()

	repoRoot, err := findRepoRoot()
	if err != nil {
		fail(err)
	}
	resolvedOpenAPI := resolvePath(repoRoot, *openapiPath)
	resolvedEnv := resolvePath(repoRoot, *envFile)
	resolvedState := resolvePath(repoRoot, *stateDir)

	apiKey, err := readAPIKey(resolvedEnv)
	if err != nil {
		fail(err)
	}
	secret := *proxySecret
	if secret == "" {
		secret, err = readProxySecret(resolvedState)
		if err != nil {
			fail(fmt.Errorf("resolve proxy secret: %w (pass --proxy-secret)", err))
		}
	}
	payload, err := os.ReadFile(resolvedOpenAPI)
	if err != nil {
		fail(fmt.Errorf("read openapi: %w", err))
	}
	parameterless, parameterized, err := extractAllGETRoutes(payload)
	if err != nil {
		fail(fmt.Errorf("parse openapi: %w", err))
	}
	// SSE endpoints never finish on their own; comparing them would always hit
	// the per-request timeout instead of a contract difference.
	routes := make([]parityRoute, 0, len(parameterless)+len(parameterized))
	for _, path := range parameterless {
		if strings.HasSuffix(path, "/stream") {
			continue
		}
		routes = append(routes, parityRoute{path: path, requestPath: path})
	}
	for _, path := range parameterized {
		if strings.HasSuffix(path, "/stream") {
			continue
		}
		routes = append(routes, parityRoute{path: path, requestPath: substitutePathParams(path, *pathParamID)})
	}
	if *limit > 0 && len(routes) > *limit {
		routes = routes[:*limit]
	}

	headers := http.Header{}
	headers.Set("X-API-Key", apiKey)
	headers.Set("X-Trusted-Proxy-Secret", secret)
	if *userID != "" {
		headers.Set("X-User-Id", *userID)
	}
	if *adminHeader != "" {
		headers.Set("X-Is-Admin", *adminHeader)
	}

	fmt.Printf("comparing %d GET routes (%d parameterless + %d with path params)\n", len(routes), len(parameterless), len(parameterized))
	client := &http.Client{Timeout: *timeout}
	results := compareAll(client, strings.TrimRight(*fastapiURL, "/"), strings.TrimRight(*goURL, "/"), headers, routes, *workers)

	failures := 0
	inconclusive := 0
	for _, item := range results {
		if item.incomparable {
			inconclusive++
			continue
		}
		if item.problem == "" {
			continue
		}
		failures++
		fmt.Printf("MISMATCH %s\n  fastapi: %d %s\n  go:      %d %s\n  reason:  %s\n",
			item.path, item.fastStatus, preview(item.fastShape), item.goStatus, preview(item.goShape), item.problem)
	}

	fmt.Printf("\ncompared %d routes: %d matched, %d mismatched, %d inconclusive (both sides 4xx/5xx with different status)\n",
		len(results), len(results)-failures-inconclusive, failures, inconclusive)
	if failures > 0 {
		os.Exit(1)
	}
}

func compareAll(client *http.Client, fastapiBase, goBase string, headers http.Header, routes []parityRoute, workers int) []comparison {
	if workers < 1 {
		workers = 1
	}
	jobs := make(chan parityRoute)
	results := make(chan comparison, len(routes))
	var waitGroup sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			for route := range jobs {
				results <- compareRoute(client, fastapiBase, goBase, headers, route)
			}
		}()
	}
	go func() {
		for _, route := range routes {
			jobs <- route
		}
		close(jobs)
	}()
	waitGroup.Wait()
	close(results)

	collected := make([]comparison, 0, len(routes))
	for item := range results {
		collected = append(collected, item)
	}
	sort.Slice(collected, func(left, right int) bool {
		if collected[left].path == collected[right].path {
			return collected[left].requestPath < collected[right].requestPath
		}
		return collected[left].path < collected[right].path
	})
	return collected
}

func compareRoute(client *http.Client, fastapiBase, goBase string, headers http.Header, route parityRoute) comparison {
	item := comparison{path: route.path, requestPath: route.requestPath}

	fastStatus, fastBody, fastErr := get(client, fastapiBase+route.requestPath, headers)
	if fastErr != nil {
		item.requestErr = "fastapi: " + fastErr.Error()
	}
	goStatus, goBody, goErr := get(client, goBase+route.requestPath, headers)
	if goErr != nil {
		if item.requestErr != "" {
			item.requestErr += "; "
		}
		item.requestErr += "go: " + goErr.Error()
	}
	item.fastStatus = fastStatus
	item.goStatus = goStatus

	if item.requestErr != "" {
		item.problem = item.requestErr
		return item
	}
	if fastStatus != goStatus {
		if fastStatus >= 400 && goStatus >= 400 {
			item.incomparable = true
		} else {
			item.problem = "status differs"
		}
	}
	if fastValue, ok := decodeJSON(fastBody); ok {
		item.fastIsJSON = true
		item.fastShape = jsonShape(fastValue)
	}
	if goValue, ok := decodeJSON(goBody); ok {
		item.goIsJSON = true
		item.goShape = jsonShape(goValue)
	}
	if fastStatus >= 200 && fastStatus < 300 && goStatus >= 200 && goStatus < 300 {
		switch {
		case item.fastIsJSON != item.goIsJSON:
			item.problem = "one side is not JSON"
		case item.fastIsJSON && item.fastShape != item.goShape:
			item.problem = "JSON shape differs"
		}
	}
	return item
}

func get(client *http.Client, url string, headers http.Header) (int, []byte, error) {
	ctx := context.Background()
	if client.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, client.Timeout)
		defer cancel()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, nil, err
	}
	for key, values := range headers {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxBodyBytes))
	if err != nil {
		return response.StatusCode, nil, err
	}
	return response.StatusCode, body, nil
}

func readAPIKey(envFile string) (string, error) {
	values, err := readEnvFile(envFile)
	if err != nil {
		return "", fmt.Errorf("read env file: %w", err)
	}
	apiKey := strings.TrimSpace(values["API_KEY"])
	if apiKey == "" {
		return "", errors.New("API_KEY is missing from the env file")
	}
	return apiKey, nil
}

func readProxySecret(stateDir string) (string, error) {
	payload, err := os.ReadFile(filepath.Join(stateDir, "state.json"))
	if err != nil {
		return "", err
	}
	var state map[string]any
	if err := json.Unmarshal(payload, &state); err != nil {
		return "", err
	}
	secret, _ := state["proxy_secret"].(string)
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return "", errors.New("state file has no proxy_secret")
	}
	return secret, nil
}

func readEnvFile(path string) (map[string]string, error) {
	payload, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	values := make(map[string]string)
	for _, raw := range strings.Split(string(payload), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 {
			first := value[0]
			last := value[len(value)-1]
			if first == last && (first == '"' || first == '\'') {
				value = value[1 : len(value)-1]
			}
		}
		values[strings.TrimSpace(key)] = value
	}
	return values, nil
}

func findRepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("could not find repo root (go.work); run from inside the repository")
		}
		dir = parent
	}
}

func resolvePath(repoRoot, path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(repoRoot, path)
}

func preview(shape string) string {
	if len(shape) <= shapePreviewSize {
		return shape
	}
	return shape[:shapePreviewSize] + "..."
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "routeparity:", err)
	os.Exit(1)
}
