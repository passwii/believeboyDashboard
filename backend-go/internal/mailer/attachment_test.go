package mailer

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type attachmentPayload struct {
	Filename string `json:"filename"`
	Content  string `json:"content"`
}

func newAttachmentTestMailer(t *testing.T, captured *[]attachmentPayload) *Mailer {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		var envelope struct {
			Attachments []attachmentPayload `json:"attachments"`
		}
		_ = json.Unmarshal(body, &envelope)
		if captured != nil {
			*captured = envelope.Attachments
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte(`{"id":"email_attachment"}`))
	}))
	t.Cleanup(server.Close)
	return New(Config{
		APIKey:     "re_test_secret",
		From:       "alerts@example.com",
		BaseURL:    server.URL,
		Timeout:    time.Second,
		HTTPClient: server.Client(),
	})
}

func TestSendAttachmentIsBase64Encoded(t *testing.T) {
	var captured []attachmentPayload
	mailer := newAttachmentTestMailer(t, &captured)
	png := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF}
	result, err := mailer.Send(context.Background(), Message{
		To:      "person@example.com",
		Subject: "Daily report",
		HTML:    "<p>report</p>",
		Attachments: []Attachment{{
			Filename: "每日报告_Shop_US_2026-11-12.png",
			Content:  png,
		}},
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if result.ID != "email_attachment" {
		t.Fatalf("Send() result = %#v", result)
	}
	if len(captured) != 1 {
		t.Fatalf("attachments = %#v", captured)
	}
	if captured[0].Filename != "每日报告_Shop_US_2026-11-12.png" {
		t.Fatalf("filename = %q", captured[0].Filename)
	}
	decoded, err := base64.StdEncoding.DecodeString(captured[0].Content)
	if err != nil {
		t.Fatalf("decode attachment content: %v", err)
	}
	if string(decoded) != string(png) {
		t.Fatalf("attachment bytes round-trip mismatch")
	}
}

func TestSendRejectsUnsafeAttachment(t *testing.T) {
	cases := []struct {
		name       string
		attachment Attachment
	}{
		{"empty filename", Attachment{Content: []byte("x")}},
		{"path traversal", Attachment{Filename: "../secret.png", Content: []byte("x")}},
		{"backslash path", Attachment{Filename: "a" + string(rune(92)) + "b.png", Content: []byte("x")}},
		{"empty content", Attachment{Filename: "report.png"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			mailer := newAttachmentTestMailer(t, nil)
			_, err := mailer.Send(context.Background(), Message{
				To:          "person@example.com",
				Subject:     "Daily report",
				HTML:        "<p>report</p>",
				Attachments: []Attachment{testCase.attachment},
			})
			if err == nil {
				t.Fatal("expected attachment validation error")
			}
			if !errors.Is(err, ErrInvalidMessage) {
				t.Fatalf("error = %v, want ErrInvalidMessage", err)
			}
		})
	}
}

func TestSendOmitsAttachmentsFieldWhenEmpty(t *testing.T) {
	var raw string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		raw = string(body)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"id":"email_plain"}`))
	}))
	t.Cleanup(server.Close)
	mailer := New(Config{
		APIKey:     "re_test_secret",
		From:       "alerts@example.com",
		BaseURL:    server.URL,
		Timeout:    time.Second,
		HTTPClient: server.Client(),
	})
	if _, err := mailer.Send(context.Background(), Message{
		To:      "person@example.com",
		Subject: "Daily report",
		HTML:    "<p>report</p>",
	}); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if strings.Contains(raw, "attachments") {
		t.Fatalf("payload should omit attachments: %s", raw)
	}
}
