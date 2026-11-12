package scheduledreport

import (
	"strings"
	"testing"
)

func TestReportAttachmentFilename(t *testing.T) {
	cases := []struct {
		name      string
		project   string
		country   string
		date      string
		frequency string
		want      string
	}{
		{"daily", "Shop US", "US", "2026-11-12", "daily", "每日报告_Shop US_US_2026-11-12.png"},
		{"weekly", "Shop US", "DE", "2026-11-12", "weekly", "每周报告_Shop US_DE_2026-11-12.png"},
		{"monthly", "Shop US", "", "2026-11", "monthly", "每月报告_Shop US_2026-11.png"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := reportAttachmentFilename(testCase.project, testCase.country, testCase.date, testCase.frequency)
			if got != testCase.want {
				t.Fatalf("filename = %q, want %q", got, testCase.want)
			}
		})
	}
}

func TestReportAttachmentFilenameSanitizesHostileCharacters(t *testing.T) {
	got := reportAttachmentFilename("a/b\\c:d*e?f\"g<h>i|j", "US", "2026-11-12", "daily")
	for _, bad := range []string{"/", "\\", ":", "*", "?", "\"", "<", ">", "|"} {
		if strings.Contains(got, bad) {
			t.Fatalf("filename %q still contains %q", got, bad)
		}
	}
	if !strings.HasSuffix(got, ".png") {
		t.Fatalf("filename %q lost the png suffix", got)
	}
}

func TestReportAttachmentFilenameTruncatesLongProjectName(t *testing.T) {
	long := strings.Repeat("店", 200)
	got := reportAttachmentFilename(long, "US", "2026-11-12", "daily")
	if !strings.Contains(got, filenameEllipsis) {
		t.Fatalf("expected ellipsis in truncated filename %q", got)
	}
	body := strings.TrimSuffix(got, ".png")
	if runes := []rune(segmentOf(body)); len(runes) > attachmentFilenameMaxRunes {
		t.Fatalf("segment has %d runes, limit %d", len(runes), attachmentFilenameMaxRunes)
	}
}

// segmentOf strips the "每日报告_" prefix and the trailing "_US_2026-11-12".
func segmentOf(body string) string {
	body = strings.TrimPrefix(body, "每日报告_")
	if index := strings.LastIndex(body, "_US_"); index >= 0 {
		return body[:index]
	}
	return body
}

func TestSanitizeAttachmentSegmentTrimsWhitespace(t *testing.T) {
	if got := sanitizeAttachmentSegment("  Shop  "); got != "Shop" {
		t.Fatalf("sanitize = %q", got)
	}
}

func TestBuildDispatchMessageAttachesScreenshot(t *testing.T) {
	png := []byte{0x89, 0x50, 0x4E, 0x47}
	message := buildDispatchMessage("person@example.com", "Daily", "<p>x</p>", png, "Shop US", "US", "2026-11-12", "daily")
	if message.To != "person@example.com" || message.Subject != "Daily" {
		t.Fatalf("message = %#v", message)
	}
	if len(message.Attachments) != 1 {
		t.Fatalf("attachments = %#v", message.Attachments)
	}
	if message.Attachments[0].Filename != "每日报告_Shop US_US_2026-11-12.png" {
		t.Fatalf("filename = %q", message.Attachments[0].Filename)
	}
	if string(message.Attachments[0].Content) != string(png) {
		t.Fatal("attachment content mismatch")
	}
}

func TestBuildDispatchMessageWithoutScreenshotHasNoAttachments(t *testing.T) {
	message := buildDispatchMessage("person@example.com", "Daily", "<p>x</p>", nil, "Shop US", "US", "2026-11-12", "daily")
	if len(message.Attachments) != 0 {
		t.Fatalf("attachments = %#v", message.Attachments)
	}
}
