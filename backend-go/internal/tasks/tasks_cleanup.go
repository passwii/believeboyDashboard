package tasks

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/hibiken/asynq"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

const (
	recoverAgentBuildTimeoutSQL = `
UPDATE agent_monthly_report_builds
SET status = 'failed',
    error_message = 'build_timeout_recovered',
    finished_at = $1,
    updated_at = $1
WHERE status = 'running'
  AND started_at IS NOT NULL
  AND started_at < $2
`
	expireAgentBuildsSQL = `
UPDATE agent_monthly_report_builds
SET status = 'expired',
    finished_at = coalesce(finished_at, $1),
    updated_at = $1
WHERE status IN ('queued', 'success', 'failed')
  AND expires_at <= $1
`
	expireAgentUploadsSQL = `
UPDATE agent_monthly_report_uploads
SET status = 'expired',
    updated_at = $1
WHERE expires_at <= $1
  AND status <> 'confirmed'
`
	selectCleanableAgentBuildsSQL = `
SELECT id
FROM agent_monthly_report_builds
WHERE status IN ('failed', 'expired', 'cancelled')
ORDER BY id
LIMIT 500
`
	selectExpiredAgentUploadsSQL = `
SELECT u.id
FROM agent_monthly_report_uploads u
WHERE u.status = 'expired'
  AND NOT EXISTS (
      SELECT 1
      FROM agent_monthly_report_builds b
      WHERE b.upload_id = u.id
        AND b.status IN ('queued', 'running')
  )
ORDER BY u.id
LIMIT 500
`
	selectAllAgentBuildIDsSQL = `
SELECT id
FROM agent_monthly_report_builds
ORDER BY id
`
	selectAllAgentUploadIDsSQL = `
SELECT id
FROM agent_monthly_report_uploads
ORDER BY id
`
)

func (handler *TaskHandler) handleAgentMonthlyReportCleanup(
	ctx context.Context,
	task *asynq.Task,
) error {
	return handler.runSafely("agent_monthly_report_cleanup", func() error {
		var payload AgentMonthlyReportCleanupPayload
		if err := handler.decodePayload(task, &payload); err != nil {
			return err
		}
		now := handler.currentTime(payload.Now)
		timeout := handler.config.AgentMonthlyReportBuildTimeout
		if timeout <= 0 {
			timeout = 25 * time.Minute
		}
		cutoff := now.Add(-timeout)

		db, err := handler.requireDB()
		if err != nil {
			return err
		}
		root := strings.TrimSpace(handler.config.AgentMonthlyReportRoot)
		if root == "" {
			return fmt.Errorf("%w: agent monthly report root", ErrDependencyNotConfigured)
		}

		timeoutTag, err := db.Exec(ctx, recoverAgentBuildTimeoutSQL, now, cutoff)
		if err != nil {
			return fmt.Errorf("recover timed-out agent monthly report builds: %w", err)
		}
		buildExpiryTag, err := db.Exec(ctx, expireAgentBuildsSQL, now)
		if err != nil {
			return fmt.Errorf("expire agent monthly report builds: %w", err)
		}
		uploadExpiryTag, err := db.Exec(ctx, expireAgentUploadsSQL, now)
		if err != nil {
			return fmt.Errorf("expire agent monthly report uploads: %w", err)
		}

		buildIDs, err := queryTaskIDs(ctx, db, selectCleanableAgentBuildsSQL)
		if err != nil {
			return fmt.Errorf("list cleanable agent monthly report builds: %w", err)
		}
		uploadIDs, err := queryTaskIDs(ctx, db, selectExpiredAgentUploadsSQL)
		if err != nil {
			return fmt.Errorf("list expired agent monthly report uploads: %w", err)
		}
		knownBuildIDs, err := queryTaskIDs(ctx, db, selectAllAgentBuildIDsSQL)
		if err != nil {
			return fmt.Errorf("list known agent monthly report builds: %w", err)
		}
		knownUploadIDs, err := queryTaskIDs(ctx, db, selectAllAgentUploadIDsSQL)
		if err != nil {
			return fmt.Errorf("list known agent monthly report uploads: %w", err)
		}

		buildsCleaned := 0
		for _, buildID := range buildIDs {
			removed, removeErr := removeAgentTaskDirectory(root, "builds", buildID)
			if removeErr != nil {
				return fmt.Errorf("clean agent monthly report build %d: %w", buildID, removeErr)
			}
			if removed {
				buildsCleaned++
			}
		}
		uploadsCleaned := 0
		for _, uploadID := range uploadIDs {
			removed, removeErr := removeAgentTaskDirectory(root, "uploads", uploadID)
			if removeErr != nil {
				return fmt.Errorf("clean agent monthly report upload %d: %w", uploadID, removeErr)
			}
			if removed {
				uploadsCleaned++
			}
		}
		orphansCleaned, err := cleanAgentOrphanDirectories(
			root,
			now.Add(-time.Hour),
			knownBuildIDs,
			knownUploadIDs,
		)
		if err != nil {
			return err
		}

		return handler.writeResult(task, taskResult{
			TaskType: "agent_monthly_report_cleanup",
			Status:   "completed",
			Data: map[string]any{
				"timeout_recovered": timeoutTag.RowsAffected(),
				"builds_expired":    buildExpiryTag.RowsAffected(),
				"uploads_expired":   uploadExpiryTag.RowsAffected(),
				"builds_cleaned":    buildsCleaned,
				"uploads_cleaned":   uploadsCleaned,
				"orphans_cleaned":   orphansCleaned,
			},
		})
	})
}

func queryTaskIDs(
	ctx context.Context,
	db store.FullDB,
	query string,
) ([]int64, error) {
	rows, err := db.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return ids, nil
}

func removeAgentTaskDirectory(root, category string, id int64) (bool, error) {
	if id <= 0 {
		return false, fmt.Errorf("invalid agent monthly report id %d", id)
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return false, fmt.Errorf("resolve agent monthly report root: %w", err)
	}
	return removeScopedAgentDirectory(root, filepath.Join(root, category, strconv.FormatInt(id, 10)))
}

func cleanAgentOrphanDirectories(
	root string,
	olderThan time.Time,
	knownBuildIDs []int64,
	knownUploadIDs []int64,
) (int, error) {
	knownBuilds := make(map[string]struct{}, len(knownBuildIDs))
	for _, id := range knownBuildIDs {
		knownBuilds[strconv.FormatInt(id, 10)] = struct{}{}
	}
	knownUploads := make(map[string]struct{}, len(knownUploadIDs))
	for _, id := range knownUploadIDs {
		knownUploads[strconv.FormatInt(id, 10)] = struct{}{}
	}

	removed := 0
	for category, known := range map[string]map[string]struct{}{
		"builds":  knownBuilds,
		"uploads": knownUploads,
	} {
		categoryRoot := filepath.Join(root, category)
		entries, err := os.ReadDir(categoryRoot)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return removed, fmt.Errorf("read agent monthly report %s directory: %w", category, err)
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			if _, ok := known[entry.Name()]; ok {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				return removed, fmt.Errorf("stat agent monthly report orphan %s: %w", entry.Name(), err)
			}
			if info.ModTime().After(olderThan) {
				continue
			}
			didRemove, err := removeScopedAgentDirectory(
				root,
				filepath.Join(categoryRoot, entry.Name()),
			)
			if err != nil {
				return removed, err
			}
			if didRemove {
				removed++
			}
		}
	}
	return removed, nil
}

func removeScopedAgentDirectory(root, candidate string) (bool, error) {
	info, err := os.Lstat(candidate)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return false, fmt.Errorf("refusing to remove symlink %s", candidate)
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	resolvedCandidate, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return false, err
	}
	relative, err := filepath.Rel(resolvedRoot, resolvedCandidate)
	if err != nil {
		return false, err
	}
	if relative == "." || relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return false, fmt.Errorf("refusing to remove path outside agent root: %s", candidate)
	}
	if err := os.RemoveAll(resolvedCandidate); err != nil {
		return false, err
	}
	return true, nil
}
