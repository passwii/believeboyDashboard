// Package testutil provides helpers shared by backend test suites.
package testutil

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
)

// windowsErrorPrivilegeNotHeld is ERROR_PRIVILEGE_NOT_HELD (1314), which
// CreateSymbolicLink returns when the process lacks SeCreateSymbolicLinkPrivilege
// (Windows without Developer Mode, or an account the capability was not granted
// to). The numeric value is harmless on other platforms: syscall.Errno uses the
// POSIX numbering there and no real errno is 1314.
const windowsErrorPrivilegeNotHeld = 1314

// RequireSymlink skips the calling test when this host cannot create symbolic
// links because the process lacks the required privilege. It probes support in
// a throwaway temp directory; callers keep creating their own symlinks (and
// still fail on unexpected errors) but are spared the platform restriction.
//
// Only a permission refusal is turned into a skip. Every other probe failure
// stays fatal so a genuine problem (missing directory, unsupported filesystem
// operation, broken target) is not silently hidden, and there is no
// runtime.GOOS check: a host that grants the privilege keeps running the test.
func RequireSymlink(t *testing.T) {
	t.Helper()

	dir := t.TempDir()
	target := filepath.Join(dir, "symlink-probe-target.txt")
	link := filepath.Join(dir, "symlink-probe-link.txt")
	if err := os.WriteFile(target, []byte("probe"), 0o600); err != nil {
		t.Fatalf("write symlink probe target: %v", err)
	}
	err := os.Symlink(target, link)
	if err == nil {
		return
	}
	if symlinkPermissionDenied(err) {
		t.Skipf(
			"symbolic links unavailable on this host (platform=%s/%s, errno=%s): %v",
			runtime.GOOS,
			runtime.GOARCH,
			describeErrno(err),
			err,
		)
		return
	}
	t.Fatalf("create symlink probe %q -> %q: %v", link, target, err)
}

// symlinkPermissionDenied reports whether err is the host refusing symlink
// creation because the caller lacks the required privilege, rather than the
// operation failing for another reason.
//
// os.Symlink wraps the syscall error in *os.LinkError. On Windows
// ERROR_PRIVILEGE_NOT_HELD is not mapped to fs.ErrPermission by syscall.Errno.Is
// (only ERROR_ACCESS_DENIED/EACCES/EPERM are), so the raw errno is inspected too.
// On POSIX hosts EPERM/EACCES surface through errors.Is(err, os.ErrPermission).
func symlinkPermissionDenied(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, os.ErrPermission) ||
		errors.Is(err, syscall.EPERM) ||
		errors.Is(err, syscall.EACCES) {
		return true
	}
	var errno syscall.Errno
	return errors.As(err, &errno) &&
		uintptr(errno) == windowsErrorPrivilegeNotHeld
}

// describeErrno renders the underlying syscall errno for the skip message.
func describeErrno(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return fmt.Sprintf("%d", uintptr(errno))
	}
	return "unknown"
}
