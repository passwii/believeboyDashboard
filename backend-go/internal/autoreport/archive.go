package autoreport

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ArchiveDir returns the destination directory for a processed file.
// Ad reports go to 广告Processed/, everything else to processed/, both at the
// project root (never inside a country subfolder).
func (c Config) ArchiveDir(file File, adReport bool) string {
	projectDir := filepath.Dir(file.Path)
	if _, ok := CountrySubfolders[filepath.Base(projectDir)]; ok {
		projectDir = filepath.Dir(projectDir)
	}
	if adReport {
		return filepath.Join(projectDir, c.AdProcessedSubdir)
	}
	return filepath.Join(projectDir, c.ProcessedSubdir)
}

// ArchiveDestination picks a non-existing path, appending _1, _2 ... on collision.
func ArchiveDestination(dir, name string) string {
	dest := filepath.Join(dir, name)
	if _, err := os.Stat(dest); err != nil {
		return dest
	}
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for counter := 1; counter < 10000; counter++ {
		candidate := filepath.Join(dir, fmt.Sprintf("%s_%d%s", stem, counter, ext))
		if _, err := os.Stat(candidate); err != nil {
			return candidate
		}
	}
	return dest
}

// MoveToArchive moves a processed file into its archive subfolder.
// A cross-device move falls back to copy+remove.
func MoveToArchive(c Config, file File, adReport bool) (string, error) {
	dir := c.ArchiveDir(file, adReport)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	dest := ArchiveDestination(dir, filepath.Base(file.Path))
	if err := os.Rename(file.Path, dest); err != nil {
		if copyErr := copyFile(file.Path, dest); copyErr != nil {
			return "", fmt.Errorf("move %s -> %s: %w", file.Path, dest, err)
		}
		if removeErr := os.Remove(file.Path); removeErr != nil {
			return "", removeErr
		}
	}
	return dest, nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// Fingerprint is the (size, mtime) pair used to detect a fully written file.
type Fingerprint struct {
	Size  int64
	Mtime time.Time
}

// StatFingerprint returns the fingerprint for a regular file.
func StatFingerprint(path string) (Fingerprint, bool) {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return Fingerprint{}, false
	}
	return Fingerprint{Size: info.Size(), Mtime: info.ModTime()}, true
}

// WaitForStable blocks until the file stops changing for samples-1 consecutive
// polls. RPA writes a file in place, so an event (or a directory entry) does not
// mean the content is complete.
func WaitForStable(path string, samples int, poll time.Duration, sleep func(time.Duration)) bool {
	if samples < 1 {
		samples = 1
	}
	if sleep == nil {
		sleep = time.Sleep
	}
	last, ok := StatFingerprint(path)
	if !ok {
		return false
	}
	unchanged := 0
	for unchanged < samples-1 {
		sleep(poll)
		current, ok := StatFingerprint(path)
		if !ok {
			return false
		}
		if current == last {
			unchanged++
			continue
		}
		last = current
		unchanged = 0
	}
	return true
}
