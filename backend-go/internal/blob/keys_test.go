package blob

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateKeyRejectsUnsafeNames(t *testing.T) {
	t.Parallel()
	testCases := []struct {
		name string
		key  string
	}{
		{name: "empty", key: ""},
		{name: "absolute", key: "/bucket/key"},
		{name: "parent traversal", key: "../secret"},
		{name: "nested traversal", key: "folder/../secret"},
		{name: "empty segment", key: "folder//file"},
		{name: "backslash", key: `folder\file`},
		{name: "control", key: "folder/\x00file"},
		{name: "format control", key: "folder/\u202efile"},
	}
	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if err := ValidateKey(testCase.key); !errors.Is(err, ErrInvalidKey) {
				t.Fatalf("ValidateKey(%q) error = %v, want ErrInvalidKey", testCase.key, err)
			}
		})
	}
}

func TestValidateKeyAcceptsUnicodeAndSpaces(t *testing.T) {
	t.Parallel()
	key := "project/images/中文 图片.png"
	if err := ValidateKey(key); err != nil {
		t.Fatalf("ValidateKey(%q) error = %v", key, err)
	}
}

func TestObjectKeyNormalizesSegments(t *testing.T) {
	t.Parallel()
	key, err := ObjectKey("  project  ", " images ", "中文  file.png ")
	if err != nil {
		t.Fatalf("ObjectKey() error = %v", err)
	}
	if want := "project/images/中文 file.png"; key != want {
		t.Fatalf("ObjectKey() = %q, want %q", key, want)
	}
}

func TestObjectKeyRejectsSeparatorInPart(t *testing.T) {
	t.Parallel()
	for _, part := range []string{"../project", "folder/file", `folder\file`} {
		if _, err := ObjectKey("project", part, "file"); !errors.Is(err, ErrInvalidKey) {
			t.Fatalf("ObjectKey() part %q error = %v, want ErrInvalidKey", part, err)
		}
	}
}

func TestObjectKeyRejectsOverlongKey(t *testing.T) {
	t.Parallel()
	if _, err := ObjectKey(strings.Repeat("a", 1025)); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("ObjectKey() error = %v, want ErrInvalidKey", err)
	}
}
