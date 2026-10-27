//go:build darwin || linux

package config

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
)

func TestConfigHelperProcess(t *testing.T) {
	if os.Getenv("BB_CONFIG_HELPER") != "1" {
		return
	}
	dir := os.Getenv("BB_CONFIG_HELPER_DIR")
	action := os.Getenv("BB_CONFIG_HELPER_ACTION")
	route := os.Getenv("BB_CONFIG_HELPER_ROUTE")
	store := NewStoreWithLocker(
		fakeDirProvider{dir: dir},
		osFileSystem{},
		NewFileLocker(),
	)
	var cfg Config
	var err error
	previousRoute := ""
	if action == "update" {
		cfg, previousRoute, err = store.updateLastRoute(context.Background(), route)
	} else {
		cfg, err = store.Load(context.Background())
		previousRoute = cfg.LastRoute
	}
	if err != nil {
		fmt.Printf("HELPER_ERROR:%v\n", err)
		os.Exit(2)
	}
	result, err := json.Marshal(map[string]string{
		"client_id":      cfg.ClientID,
		"previous_route": previousRoute,
		"route":          cfg.LastRoute,
	})
	if err != nil {
		fmt.Printf("HELPER_ERROR:%v\n", err)
		os.Exit(2)
	}
	fmt.Printf("HELPER_RESULT:%s\n", result)
	os.Exit(0)
}

func TestConcurrentProcessesConvergeOnOneClientID(t *testing.T) {
	dir := t.TempDir()
	const processes = 8
	results := make(chan helperResult, processes)
	var wait sync.WaitGroup
	for i := 0; i < processes; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			results <- runConfigHelper(dir, "load", "")
		}()
	}
	wait.Wait()
	close(results)

	var want string
	for result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		if want == "" {
			want = result.clientID
		}
		if result.clientID != want {
			t.Errorf("client_id = %q, want converged %q", result.clientID, want)
		}
	}
	persisted, err := NewStoreWithLocker(
		fakeDirProvider{dir: dir},
		osFileSystem{},
		NewFileLocker(),
	).Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if persisted.ClientID != want {
		t.Errorf("persisted client_id = %q, want %q", persisted.ClientID, want)
	}
}

func TestConcurrentProcessRouteUpdatesUseCrossProcessReadModifyWriteLock(t *testing.T) {
	dir := t.TempDir()
	store := NewStoreWithLocker(
		fakeDirProvider{dir: dir},
		osFileSystem{},
		NewFileLocker(),
	)
	initial, err := store.UpdateLastRoute(context.Background(), "/initial")
	if err != nil {
		t.Fatal(err)
	}

	const processes = 8
	routes := make([]string, processes)
	results := make(chan helperResult, processes)
	var wait sync.WaitGroup
	for i := 0; i < processes; i++ {
		routes[i] = fmt.Sprintf("/route-%d", i)
		wait.Add(1)
		go func(route string) {
			defer wait.Done()
			results <- runConfigHelper(dir, "update", route)
		}(routes[i])
	}
	wait.Wait()
	close(results)

	sawInitial := 0
	for result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.previousRoute == "/initial" {
			sawInitial++
		}
	}
	if sawInitial != 1 {
		t.Errorf("processes observing initial route = %d, want exactly 1 with read-modify-write locking", sawInitial)
	}

	path, err := store.Path()
	if err != nil {
		t.Fatal(err)
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var cfg Config
	if err := json.Unmarshal(payload, &cfg); err != nil {
		t.Fatalf("final config is corrupt: %v\n%s", err, payload)
	}
	if cfg.ClientID != initial.ClientID {
		t.Errorf("client_id changed = %q, want %q", cfg.ClientID, initial.ClientID)
	}
	if !contains(routes, cfg.LastRoute) {
		t.Errorf("last_route = %q, want one of %v", cfg.LastRoute, routes)
	}
}

type helperResult struct {
	clientID      string
	previousRoute string
	route         string
	err           error
}

func runConfigHelper(dir, action, route string) helperResult {
	command := exec.Command(os.Args[0], "-test.run=^TestConfigHelperProcess$")
	command.Env = append(os.Environ(),
		"BB_CONFIG_HELPER=1",
		"BB_CONFIG_HELPER_DIR="+dir,
		"BB_CONFIG_HELPER_ACTION="+action,
		"BB_CONFIG_HELPER_ROUTE="+route,
	)
	output, err := command.CombinedOutput()
	if err != nil {
		return helperResult{err: fmt.Errorf("helper failed: %w\n%s", err, output)}
	}
	for _, line := range strings.Split(string(output), "\n") {
		if !strings.HasPrefix(line, "HELPER_RESULT:") {
			continue
		}
		var result struct {
			ClientID      string `json:"client_id"`
			PreviousRoute string `json:"previous_route"`
			Route         string `json:"route"`
		}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "HELPER_RESULT:")), &result); err != nil {
			return helperResult{err: err}
		}
		return helperResult{
			clientID:      result.ClientID,
			previousRoute: result.PreviousRoute,
			route:         result.Route,
		}
	}
	return helperResult{err: fmt.Errorf("helper returned no result:\n%s", output)}
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
