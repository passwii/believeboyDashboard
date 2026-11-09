package ai

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestEncodeSSEUsesAnthropicShapeAndOptionalID(t *testing.T) {
	event := NewMessageStart("message-1", "model-a", 1770000000000)
	encoded := EncodeSSE(event, "1-0")
	text := string(encoded)
	if !strings.HasPrefix(text, "id: 1-0\n") {
		t.Fatalf("encoded SSE = %q, want id line", text)
	}
	if !strings.HasSuffix(text, "\n\n") {
		t.Fatalf("encoded SSE does not end with blank line: %q", text)
	}
	dataLine := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(text, "id: 1-0\n"), "data: "))
	var payload map[string]any
	if err := json.Unmarshal([]byte(dataLine), &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload["type"] != "message_start" || payload["message_id"] != "message-1" ||
		payload["model"] != "model-a" || payload["role"] != "assistant" {
		t.Errorf("payload = %#v", payload)
	}
	if payload["created_at"].(float64) != 1770000000000 {
		t.Errorf("created_at = %#v", payload["created_at"])
	}

	textDelta := NewContentBlockDeltaText(0, "hello")
	encoded = EncodeSSE(textDelta, "")
	if !strings.HasPrefix(string(encoded), "data: ") {
		t.Errorf("SSE without id = %q", encoded)
	}
}

func TestProtocolEventConstructorsUseSnakeCaseFields(t *testing.T) {
	start := NewContentBlockStartText(0)
	usage := NewMessageDelta(Usage{InputTokens: 3, OutputTokens: 5, TotalTokens: 8}, "end_turn")
	errorEvent := NewErrorEvent("cancelled", "用户取消", 0)
	for _, event := range []any{start, usage, errorEvent} {
		data, err := json.Marshal(event)
		if err != nil {
			t.Fatalf("marshal event: %v", err)
		}
		if strings.Contains(string(data), "ContentBlock") || strings.Contains(string(data), "StopReason") {
			t.Errorf("event leaked Go field names: %s", data)
		}
	}
}
