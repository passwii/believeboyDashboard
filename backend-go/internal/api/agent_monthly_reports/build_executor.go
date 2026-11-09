package agent_monthly_reports

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/passwii/believeboyDashboard/backend-go/internal/queue"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
	"github.com/passwii/believeboyDashboard/backend-go/internal/tasks"
)

type QueueBuildDispatcher struct {
	Client *queue.QueueClient
}

func (dispatcher *QueueBuildDispatcher) EnqueueBuild(
	ctx context.Context,
	buildID int64,
) error {
	if dispatcher == nil || dispatcher.Client == nil {
		return fmt.Errorf("agent monthly report queue client is not configured")
	}
	_, err := dispatcher.Client.Enqueue(
		ctx,
		queue.TypeBuildMonthlyReportPreview,
		tasks.MonthlyReportPreviewPayload{BuildID: buildID},
	)
	return err
}

type BuildExecutor struct {
	store         Store
	root          string
	maxInputBytes int64
}

func NewBuildExecutor(storeValue Store, root string, maxInputBytes int64) *BuildExecutor {
	root = strings.TrimSpace(root)
	if root == "" {
		root = strings.TrimSpace(os.Getenv("AGENT_MONTHLY_REPORT_ROOT"))
	}
	if root == "" {
		root = "backend/storage/agent_monthly_reports"
	}
	if maxInputBytes <= 0 {
		maxInputBytes = 50 * 1024 * 1024
	}
	return &BuildExecutor{
		store:         storeValue,
		root:          root,
		maxInputBytes: maxInputBytes,
	}
}

func (executor *BuildExecutor) ExecuteBuild(
	ctx context.Context,
	buildID int64,
) (any, error) {
	if executor == nil || executor.store == nil {
		return nil, store.ErrAgentMonthlyDependency
	}
	claim, err := executor.store.ClaimAgentMonthlyBuild(ctx, buildID)
	if err != nil {
		if errors.Is(err, store.ErrAgentMonthlyConflict) {
			return map[string]any{"status": "skipped", "build_id": buildID}, nil
		}
		if errors.Is(err, store.ErrAgentMonthlyNotFound) {
			return map[string]any{"status": "missing", "build_id": buildID}, nil
		}
		return nil, err
	}
	if claim == nil || claim.Build == nil {
		return nil, store.ErrAgentMonthlyNotFound
	}

	buildDirectory, err := executor.secureBuildDirectory(buildID)
	if err != nil {
		_ = executor.store.FailAgentMonthlyBuild(ctx, buildID, "storage_unavailable")
		return nil, err
	}
	inputRoot, err := executor.secureBuildInputRoot(buildDirectory)
	if err != nil {
		_ = executor.store.FailAgentMonthlyBuild(ctx, buildID, "input_storage_unavailable")
		return nil, err
	}
	projectFolder := safeMonthlyBuildProjectFolder(claim.Build.ProjectName)
	inputDirectory, err := safeAssistantDirectory(
		inputRoot,
		projectFolder,
		"payment-report",
	)
	if err != nil {
		_ = executor.store.FailAgentMonthlyBuild(ctx, buildID, "input_path_unsafe")
		return nil, err
	}
	transactionFilename := fmt.Sprintf("input-%s.csv", randomHex(12))
	transactionPath := filepath.Join(inputDirectory, transactionFilename)
	sourceDigest, err := sha256File(claim.TransactionPath)
	if err != nil {
		_ = executor.store.FailAgentMonthlyBuild(ctx, buildID, "input_missing")
		return map[string]any{"status": "failed", "reason": "input_missing"}, nil
	}
	if sourceDigest != claim.Build.InputSHA256 {
		_ = executor.store.FailAgentMonthlyBuild(ctx, buildID, "input_changed")
		return map[string]any{"status": "failed", "reason": "input_changed"}, nil
	}
	if err := copyRegularFile(claim.TransactionPath, transactionPath, executor.maxInputBytes); err != nil {
		_ = executor.store.FailAgentMonthlyBuild(ctx, buildID, "input_copy_failed")
		return nil, err
	}
	defer os.Remove(transactionPath)

	generator := tasks.NewFileMonthlyReportGeneratorWithLimit(
		inputRoot,
		filepath.Join(executor.root, "builds"),
		executor.maxInputBytes,
	)
	result, err := generator.Generate(ctx, tasks.MonthlyReportGenerationInput{
		JobID:             buildID,
		ProjectID:         claim.Build.ProjectID,
		ProjectName:       claim.Build.ProjectName,
		Country:           claim.Build.Country,
		ReportMonth:       claim.Build.ReportMonth,
		TransactionFileID: transactionFilename,
	})
	if err != nil {
		_ = executor.store.FailAgentMonthlyBuild(ctx, buildID, "calculation: "+err.Error())
		return map[string]any{"status": "failed", "reason": "calculation"}, nil
	}
	copiedDigest, err := sha256File(transactionPath)
	if err != nil || copiedDigest != sourceDigest {
		_ = executor.store.FailAgentMonthlyBuild(ctx, buildID, "input_changed")
		return map[string]any{"status": "failed", "reason": "input_changed"}, nil
	}
	if err := executor.store.CompleteAgentMonthlyBuild(ctx, buildID, *result); err != nil {
		_ = executor.store.FailAgentMonthlyBuild(ctx, buildID, "artifact_persist: "+err.Error())
		return nil, err
	}
	return map[string]any{"status": "success", "build_id": buildID}, nil
}

func (executor *BuildExecutor) secureBuildDirectory(buildID int64) (string, error) {
	root, err := secureDirectory(executor.root)
	if err != nil {
		return "", err
	}
	return safeAssistantDirectory(root, "builds", strconv.FormatInt(buildID, 10))
}

func (executor *BuildExecutor) secureBuildInputRoot(buildDirectory string) (string, error) {
	return safeAssistantDirectory(buildDirectory, "input")
}

func secureDirectory(root string) (string, error) {
	absolute, err := filepath.Abs(strings.TrimSpace(root))
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return "", err
	}
	info, err := os.Lstat(absolute)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", store.ErrAgentMonthlyDependency
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	return resolved, nil
}

func safeAssistantDirectory(root string, segments ...string) (string, error) {
	resolvedRoot, err := secureDirectory(root)
	if err != nil {
		return "", err
	}
	candidate := filepath.Join(append([]string{resolvedRoot}, segments...)...)
	if err := os.MkdirAll(candidate, 0o700); err != nil {
		return "", err
	}
	info, err := os.Lstat(candidate)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", store.ErrAgentMonthlyInvalidInput
	}
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil || !pathWithin(resolvedRoot, resolved) {
		return "", store.ErrAgentMonthlyInvalidInput
	}
	return resolved, nil
}

func copyRegularFile(source, destination string, maxBytes int64) error {
	info, err := os.Lstat(source)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return store.ErrAgentMonthlyNotReady
	}
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	success := false
	defer func() {
		_ = output.Close()
		if !success {
			_ = os.Remove(destination)
		}
	}()
	copied, err := io.Copy(output, io.LimitReader(input, maxBytes+1))
	if err != nil {
		return err
	}
	if copied > maxBytes {
		return store.ErrAgentMonthlyInvalidInput
	}
	if err := output.Sync(); err != nil {
		return err
	}
	if err := output.Close(); err != nil {
		return err
	}
	success = true
	return nil
}

func sha256File(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func randomHex(size int) string {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return strconv.FormatInt(timeNowUnixNano(), 16)
	}
	return hex.EncodeToString(buffer)
}

func timeNowUnixNano() int64 {
	return nowFunc().UnixNano()
}

var nowFunc = func() time.Time { return time.Now() }

func safeMonthlyBuildProjectFolder(value string) string {
	var builder strings.Builder
	for _, character := range strings.TrimSpace(value) {
		switch {
		case strings.ContainsRune(`\/:*?"<>|`, character), unicode.IsControl(character):
			builder.WriteByte('-')
		case unicode.IsSpace(character):
			builder.WriteByte('-')
		default:
			builder.WriteRune(character)
		}
	}
	result := strings.Trim(builder.String(), " .-")
	if result == "" {
		result = "project"
	}
	runes := []rune(result)
	if len(runes) > 80 {
		result = string(runes[:80])
	}
	return result
}

func pathWithin(root, candidate string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	if err != nil || filepath.IsAbs(relative) {
		return false
	}
	return relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
