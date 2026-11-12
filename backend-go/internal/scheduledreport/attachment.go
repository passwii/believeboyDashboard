package scheduledreport

import (
	"strings"
	"unicode/utf8"
)

// Attachment filename limits mirror the Python helpers in
// backend/app/services/scheduled_report/_name_utils.py so a report delivered by
// the Go worker produces the same download name as the FastAPI worker did.
const (
	attachmentFilenameMaxRunes = 120
	filenameEllipsis           = "…"
	badFilenameChars           = "/\\:*?\"<>|\r\n\t"
)

// sanitizeAttachmentSegment replaces filesystem-hostile characters and caps the
// rune length, keeping the name safe on Windows, macOS, Linux and object storage.
func sanitizeAttachmentSegment(segment string) string {
	clean := strings.Map(func(r rune) rune {
		if strings.ContainsRune(badFilenameChars, r) {
			return '_'
		}
		return r
	}, segment)
	clean = strings.TrimSpace(clean)
	return truncateRunes(clean, attachmentFilenameMaxRunes)
}

// truncateRunes cuts at a rune boundary; byte slicing would split multi-byte
// CJK characters and produce an invalid attachment name.
func truncateRunes(value string, maxRunes int) string {
	if utf8.RuneCountInString(value) <= maxRunes {
		return value
	}
	runes := []rune(value)
	return string(runes[:maxRunes-1]) + filenameEllipsis
}

// reportAttachmentFilename builds the PNG attachment name used for scheduled
// reports, e.g. "每日报告_Shop_US_2026-11-12.png".
func reportAttachmentFilename(projectName, country, reportDate, frequency string) string {
	segment := sanitizeAttachmentSegment(projectName)
	if segment == "" {
		segment = "report"
	}
	country = sanitizeAttachmentSegment(country)
	reportDate = sanitizeAttachmentSegment(reportDate)
	parts := []string{frequencyLabel(frequency) + "报告", segment}
	if country != "" {
		parts = append(parts, country)
	}
	if reportDate != "" {
		parts = append(parts, reportDate)
	}
	return strings.Join(parts, "_") + ".png"
}
