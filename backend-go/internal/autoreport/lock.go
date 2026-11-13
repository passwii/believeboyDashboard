package autoreport

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// Lock is an advisory single-instance lock.
type Lock struct {
	path string
	file *os.File
}

// AcquireLock takes an exclusive non-blocking lock next to the watch root.
// A second daemon fails fast instead of double-processing files.
func AcquireLock(root string) (*Lock, error) {
	path := filepath.Join(root, ".autoreport.lock")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, fmt.Errorf("另一个 autoreport-upload 实例正在运行（锁 %s）: %w", path, err)
	}
	if _, err := file.WriteString(fmt.Sprintf("%d\n", os.Getpid())); err != nil {
		file.Close()
		return nil, err
	}
	return &Lock{path: path, file: file}, nil
}

// Release drops the lock. Safe to call once.
func (l *Lock) Release() {
	if l == nil || l.file == nil {
		return
	}
	_ = syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN)
	_ = l.file.Close()
	l.file = nil
}

// Path returns the lock file path (used by the CLI for logging).
func (l *Lock) Path() string { return l.path }
