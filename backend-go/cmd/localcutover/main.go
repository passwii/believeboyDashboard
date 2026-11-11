// Command localcutover runs the whole Go backend locally (gateway, worker,
// scheduler) against the local test database so a full FastAPI -> Go cutover
// can be verified without touching the VPS.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

const (
	defaultEnvFile      = "backend/.env.test"
	defaultGatewayAddr  = "127.0.0.1:18200"
	defaultFastAPIURL   = "http://127.0.0.1:8100"
	defaultStateDir     = ".local-cutover"
	readinessTimeout    = 45 * time.Second
	processStopTimeout  = 10 * time.Second
	healthRequestTimout = 3 * time.Second
)

type state struct {
	GatewayPID   int       `json:"gateway_pid"`
	WorkerPID    int       `json:"worker_pid"`
	SchedulerPID int       `json:"scheduler_pid"`
	StartedAt    time.Time `json:"started_at"`
	GatewayAddr  string    `json:"gateway_addr"`
	ProxySecret  string    `json:"proxy_secret"`
	EnvFile      string    `json:"env_file"`
	APIFile      string    `json:"api_env_file"`
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "up":
		err = runUp(os.Args[2:])
	case "down":
		err = runDown(os.Args[2:])
	case "status":
		err = runStatus(os.Args[2:])
	case "logs":
		err = runLogs(os.Args[2:])
	case "-h", "--help", "help":
		usage()
		return
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "localcutover:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `localcutover runs the Go backend locally for full-cutover verification.

Usage:
  go run ./cmd/localcutover up    [flags]
  go run ./cmd/localcutover down  [flags]
  go run ./cmd/localcutover status [flags]
  go run ./cmd/localcutover logs  [flags]

Run "go run ./cmd/localcutover up -h" for the up flags.
`)
}

func runUp(args []string) error {
	flags := flag.NewFlagSet("up", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	envFile := flags.String("env-file", defaultEnvFile, "env file with API_KEY and DATABASE_URL (relative paths resolve from the repo root)")
	owned := flags.String("owned", "all", "GO_API_OWNED value; use all for a full cutover")
	gatewayAddr := flags.String("gateway-addr", defaultGatewayAddr, "gateway listen address")
	fastapiOrigin := flags.String("fastapi-origin", defaultFastAPIURL, "FastAPI fallback origin")
	stateDir := flags.String("state-dir", defaultStateDir, "directory for binaries, logs and state")
	stopPython := flags.Bool("stop-python-celery", false, "stop local Python celery/beat processes before starting the Go worker")
	skipWorker := flags.Bool("no-worker", false, "do not start the Go worker")
	skipScheduler := flags.Bool("no-scheduler", false, "do not start the Go scheduler")
	if err := flags.Parse(args); err != nil {
		return err
	}

	repoRoot, err := findRepoRoot()
	if err != nil {
		return err
	}
	resolvedEnvFile := *envFile
	if !filepath.IsAbs(resolvedEnvFile) {
		resolvedEnvFile = filepath.Join(repoRoot, resolvedEnvFile)
	}
	values, err := parseEnvFile(resolvedEnvFile)
	if err != nil {
		return fmt.Errorf("read env file: %w", err)
	}
	apiKey := strings.TrimSpace(values["API_KEY"])
	if apiKey == "" {
		return errors.New("API_KEY is missing from the env file")
	}
	databaseURL, err := databaseURLFromEnv(values)
	if err != nil {
		return err
	}
	redisURL := redisURLFromEnv(values)

	statePath := resolveStateDir(repoRoot, *stateDir)
	if err := os.MkdirAll(statePath, 0o700); err != nil {
		return err
	}
	if existing, err := loadState(statePath); err == nil {
		fmt.Println("stopping processes from the previous run...")
		_ = stopProcesses(existing, statePath)
	}

	if *stopPython {
		stopPythonCelery()
	} else {
		fmt.Println("note: if local Python celery/beat are running they will double-run tasks; pass --stop-python-celery to stop them")
	}

	logDir := filepath.Join(statePath, "logs")
	binDir := filepath.Join(statePath, "bin")
	storageDir := filepath.Join(statePath, "storage")
	for _, dir := range []string{
		logDir, binDir,
		filepath.Join(storageDir, "uploads"),
		filepath.Join(storageDir, "results"),
		filepath.Join(storageDir, "agent_monthly_reports"),
		filepath.Join(storageDir, "project_launch_documents"),
	} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
	}

	if err := buildBinaries(repoRoot, binDir); err != nil {
		return err
	}

	proxySecret := strings.TrimSpace(values["GO_API_TRUSTED_PROXY_SECRET"])
	if proxySecret == "" {
		proxySecret, err = randomSecret()
		if err != nil {
			return err
		}
	}
	processEnv := deriveProcessEnv(values, processEnvOptions{
		apiKey:        apiKey,
		databaseURL:   databaseURL,
		redisURL:      redisURL,
		gatewayAddr:   *gatewayAddr,
		fastapiOrigin: *fastapiOrigin,
		owned:         *owned,
		proxySecret:   proxySecret,
		storageDir:    storageDir,
	})
	apiEnvPath := filepath.Join(statePath, "api.env")
	if err := writeEnvFile(apiEnvPath, processEnv); err != nil {
		return err
	}

	newState := &state{
		StartedAt:   time.Now(),
		GatewayAddr: *gatewayAddr,
		ProxySecret: proxySecret,
		EnvFile:     resolvedEnvFile,
		APIFile:     apiEnvPath,
	}

	gatewayLog := filepath.Join(logDir, "gateway.log")
	gatewayPID, err := startProcess(filepath.Join(binDir, "go-gateway"), repoRoot, processEnv, gatewayLog)
	if err != nil {
		return fmt.Errorf("start gateway: %w", err)
	}
	newState.GatewayPID = gatewayPID
	fmt.Printf("gateway started: pid=%d log=%s\n", gatewayPID, gatewayLog)

	readinessURL := gatewayURL(*gatewayAddr) + "/api/v1/health/ready"
	if err := waitForReadiness(readinessURL); err != nil {
		printTail(gatewayLog, 40)
		_ = stopProcesses(newState, statePath)
		return err
	}
	fmt.Printf("gateway ready: %s\n", gatewayURL(*gatewayAddr)+"/api/v1/health/ready")

	if !*skipWorker {
		workerLog := filepath.Join(logDir, "worker.log")
		workerPID, err := startProcess(filepath.Join(binDir, "go-worker"), repoRoot, processEnv, workerLog)
		if err != nil {
			_ = stopProcesses(newState, statePath)
			return fmt.Errorf("start worker: %w", err)
		}
		newState.WorkerPID = workerPID
		fmt.Printf("worker started: pid=%d log=%s\n", workerPID, workerLog)
	}
	if !*skipScheduler {
		schedulerLog := filepath.Join(logDir, "scheduler.log")
		schedulerPID, err := startProcess(filepath.Join(binDir, "go-scheduler"), repoRoot, processEnv, schedulerLog)
		if err != nil {
			_ = stopProcesses(newState, statePath)
			return fmt.Errorf("start scheduler: %w", err)
		}
		newState.SchedulerPID = schedulerPID
		fmt.Printf("scheduler started: pid=%d log=%s\n", schedulerPID, schedulerLog)
	}

	time.Sleep(2 * time.Second)
	if alive, dead := aliveStatus(newState); !alive {
		for name, pid := range dead {
			fmt.Printf("ERROR: %s (pid=%d) exited during startup\n", name, pid)
			printTail(filepath.Join(logDir, name+".log"), 30)
		}
		_ = stopProcesses(newState, statePath)
		return errors.New("a Go process exited during startup")
	}

	if err := saveState(statePath, newState); err != nil {
		return err
	}

	fmt.Println()
	fmt.Println("local full cutover is running")
	fmt.Printf("  gateway   http://%s\n", *gatewayAddr)
	fmt.Printf("  modules   GO_API_OWNED=%s\n", *owned)
	fmt.Printf("  env file  %s\n", apiEnvPath)
	fmt.Printf("  state     %s\n", statePath)
	fmt.Println()
	fmt.Println("sample requests (load the exported env file first):")
	fmt.Printf("  set -a; . %s; set +a\n", apiEnvPath)
	fmt.Printf("  curl -s -o /dev/null -w '%%{http_code}\\n' http://%s/api/v1/health/ready\n", *gatewayAddr)
	fmt.Printf("  curl -s -H \"X-API-Key: $API_KEY\" -H \"X-Trusted-Proxy-Secret: $GO_API_TRUSTED_PROXY_SECRET\" http://%s/api/v1/projects/manage\n", *gatewayAddr)
	fmt.Println("  user-scoped routes also need -H 'X-User-Id: <user id>'")
	fmt.Println("watch fallbacks: grep 'fell back to FastAPI' " + filepath.Join(logDir, "gateway.log"))
	return nil
}

func runDown(args []string) error {
	flags := flag.NewFlagSet("down", flag.ContinueOnError)
	stateDir := flags.String("state-dir", defaultStateDir, "directory with the runtime state")
	repoRoot, err := findRepoRoot()
	if err != nil {
		return err
	}
	if err := flags.Parse(args); err != nil {
		return err
	}
	statePath := resolveStateDir(repoRoot, *stateDir)
	current, err := loadState(statePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			fmt.Println("no local cutover state found; nothing to stop")
			return nil
		}
		return err
	}
	return stopProcesses(current, statePath)
}

func runStatus(args []string) error {
	flags := flag.NewFlagSet("status", flag.ContinueOnError)
	stateDir := flags.String("state-dir", defaultStateDir, "directory with the runtime state")
	repoRoot, err := findRepoRoot()
	if err != nil {
		return err
	}
	if err := flags.Parse(args); err != nil {
		return err
	}
	statePath := resolveStateDir(repoRoot, *stateDir)
	current, err := loadState(statePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			fmt.Println("not running (no state file)")
			return nil
		}
		return err
	}
	fmt.Printf("started: %s\n", current.StartedAt.Format(time.RFC3339))
	for _, process := range []struct {
		name string
		pid  int
	}{
		{"gateway", current.GatewayPID},
		{"worker", current.WorkerPID},
		{"scheduler", current.SchedulerPID},
	} {
		if process.pid == 0 {
			fmt.Printf("%-9s not started\n", process.name)
			continue
		}
		if processAlive(process.pid) {
			fmt.Printf("%-9s running (pid=%d)\n", process.name, process.pid)
		} else {
			fmt.Printf("%-9s exited (pid=%d)\n", process.name, process.pid)
		}
	}
	code, err := httpStatus(gatewayURL(current.GatewayAddr) + "/api/v1/health/ready")
	if err != nil {
		fmt.Printf("readiness unreachable: %v\n", err)
		return nil
	}
	fmt.Printf("readiness HTTP %d\n", code)
	return nil
}

func runLogs(args []string) error {
	flags := flag.NewFlagSet("logs", flag.ContinueOnError)
	stateDir := flags.String("state-dir", defaultStateDir, "directory with the runtime state")
	lines := flags.Int("lines", 40, "number of trailing lines per process")
	repoRoot, err := findRepoRoot()
	if err != nil {
		return err
	}
	if err := flags.Parse(args); err != nil {
		return err
	}
	statePath := resolveStateDir(repoRoot, *stateDir)
	for _, name := range []string{"gateway", "worker", "scheduler"} {
		path := filepath.Join(statePath, "logs", name+".log")
		fmt.Printf("== %s (%s) ==\n", name, path)
		printTail(path, *lines)
	}
	return nil
}

type processEnvOptions struct {
	apiKey        string
	databaseURL   string
	redisURL      string
	gatewayAddr   string
	fastapiOrigin string
	owned         string
	proxySecret   string
	storageDir    string
}

// deriveProcessEnv overlays the env file on the current environment, normalizes
// the database/redis URLs for pgx and points all storage roots at the local
// state directory.
func deriveProcessEnv(values map[string]string, options processEnvOptions) map[string]string {
	env := make(map[string]string, len(values)+16)
	for key, value := range values {
		env[key] = value
	}
	env["API_KEY"] = options.apiKey
	env["DATABASE_URL"] = options.databaseURL
	env["REDIS_URL"] = options.redisURL
	env["GO_API_ADDR"] = options.gatewayAddr
	env["FASTAPI_ORIGIN"] = options.fastapiOrigin
	env["GO_API_OWNED"] = options.owned
	env["GO_API_TRUSTED_PROXY_SECRET"] = options.proxySecret
	env["APP_ENV"] = "local-cutover"
	env["UPLOAD_ROOT"] = filepath.Join(options.storageDir, "uploads")
	env["MONTHLY_REPORT_RESULT_ROOT"] = filepath.Join(options.storageDir, "results")
	env["AGENT_MONTHLY_REPORT_ROOT"] = filepath.Join(options.storageDir, "agent_monthly_reports")
	env["PROJECT_LAUNCH_DOCUMENTS_ROOT"] = filepath.Join(options.storageDir, "project_launch_documents")
	return env
}

func buildBinaries(repoRoot, binDir string) error {
	backendDir := filepath.Join(repoRoot, "backend-go")
	for _, name := range []string{"gateway", "worker", "scheduler"} {
		output := filepath.Join(binDir, "go-"+name)
		command := exec.Command("go", "build", "-o", output, "./cmd/"+name)
		command.Dir = backendDir
		command.Stdout = os.Stderr
		command.Stderr = os.Stderr
		if err := command.Run(); err != nil {
			return fmt.Errorf("go build ./cmd/%s: %w", name, err)
		}
		fmt.Printf("built %s\n", output)
	}
	return nil
}

func startProcess(binary, repoRoot string, env map[string]string, logPath string) (int, error) {
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return 0, err
	}
	command := exec.Command(binary)
	command.Dir = filepath.Join(repoRoot, "backend-go")
	command.Env = envSlice(env)
	command.Stdout = logFile
	command.Stderr = logFile
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		_ = logFile.Close()
		return 0, err
	}
	pid := command.Process.Pid
	go func() {
		_ = command.Wait()
		_ = logFile.Close()
	}()
	return pid, nil
}

func waitForReadiness(url string) error {
	deadline := time.Now().Add(readinessTimeout)
	for time.Now().Before(deadline) {
		code, err := httpStatus(url)
		if err == nil && code == http.StatusOK {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("gateway did not become ready at %s within %s", url, readinessTimeout)
}

func httpStatus(url string) (int, error) {
	client := &http.Client{Timeout: healthRequestTimout}
	response, err := client.Get(url)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	return response.StatusCode, nil
}

func gatewayURL(addr string) string {
	if strings.HasPrefix(addr, "http://") || strings.HasPrefix(addr, "https://") {
		return strings.TrimSuffix(addr, "/")
	}
	return "http://" + strings.TrimSuffix(addr, "/")
}

func stopProcesses(current *state, statePath string) error {
	pids := []int{current.GatewayPID, current.WorkerPID, current.SchedulerPID}
	for _, pid := range pids {
		if pid <= 0 || !processAlive(pid) {
			continue
		}
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}
	deadline := time.Now().Add(processStopTimeout)
	for time.Now().Before(deadline) {
		remaining := false
		for _, pid := range pids {
			if pid > 0 && processAlive(pid) {
				remaining = true
				break
			}
		}
		if !remaining {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	for _, pid := range pids {
		if pid > 0 && processAlive(pid) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	if err := os.Remove(filepath.Join(statePath, "state.json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	fmt.Println("stopped")
	return nil
}

func aliveStatus(current *state) (bool, map[string]int) {
	dead := make(map[string]int)
	allAlive := true
	for _, process := range []struct {
		name string
		pid  int
	}{
		{"gateway", current.GatewayPID},
		{"worker", current.WorkerPID},
		{"scheduler", current.SchedulerPID},
	} {
		if process.pid > 0 && !processAlive(process.pid) {
			dead[process.name] = process.pid
			allAlive = false
		}
	}
	return allAlive, dead
}

func processAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func stopPythonCelery() {
	patterns := []string{
		"celery -A app.tasks.celery_app",
		"celery -A app.tasks.celery_beat_app",
	}
	for _, pattern := range patterns {
		command := exec.Command("pkill", "-f", pattern)
		if err := command.Run(); err != nil {
			fmt.Printf("no local python celery matched %q\n", pattern)
			continue
		}
		fmt.Printf("stopped local python celery: %s\n", pattern)
	}
}

func loadState(statePath string) (*state, error) {
	payload, err := os.ReadFile(filepath.Join(statePath, "state.json"))
	if err != nil {
		return nil, err
	}
	var current state
	if err := json.Unmarshal(payload, &current); err != nil {
		return nil, err
	}
	return &current, nil
}

func saveState(statePath string, current *state) error {
	payload, err := json.MarshalIndent(current, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(statePath, "state.json"), payload, 0o600)
}

func writeEnvFile(path string, env map[string]string) error {
	var builder strings.Builder
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		builder.WriteString(key)
		builder.WriteString("=")
		builder.WriteString(shellQuote(env[key]))
		builder.WriteString("\n")
	}
	return os.WriteFile(path, []byte(builder.String()), 0o600)
}

// shellQuote makes the generated env file sourceable by bash even when values
// contain spaces, parentheses or quotes.
func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func envSlice(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, key+"="+env[key])
	}
	return result
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

func resolveStateDir(repoRoot, stateDir string) string {
	if filepath.IsAbs(stateDir) {
		return stateDir
	}
	return filepath.Join(repoRoot, stateDir)
}

func randomSecret() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func printTail(path string, lines int) {
	file, err := os.Open(path)
	if err != nil {
		fmt.Printf("(no log: %v)\n", err)
		return
	}
	defer file.Close()
	content, err := io.ReadAll(file)
	if err != nil {
		fmt.Printf("(read log: %v)\n", err)
		return
	}
	all := strings.Split(strings.TrimRight(string(content), "\n"), "\n")
	start := len(all) - lines
	if start < 0 {
		start = 0
	}
	for _, line := range all[start:] {
		fmt.Println(line)
	}
}

func redact(value string) string {
	if len(value) <= 6 {
		return "***"
	}
	return value[:4] + "***" + value[len(value)-2:]
}
