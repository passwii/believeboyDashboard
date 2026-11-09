package ai

import (
	"bytes"
	"encoding/json"
)

type ProtocolEvent struct {
	Type         string         `json:"type"`
	MessageID    string         `json:"message_id,omitempty"`
	Model        string         `json:"model,omitempty"`
	Role         string         `json:"role,omitempty"`
	CreatedAt    int64          `json:"created_at,omitempty"`
	Index        *int           `json:"index,omitempty"`
	ContentBlock map[string]any `json:"content_block,omitempty"`
	Delta        map[string]any `json:"delta,omitempty"`
	Usage        *Usage         `json:"usage,omitempty"`
	StopReason   string         `json:"stop_reason,omitempty"`
	Error        *ProtocolError `json:"error,omitempty"`
}

type ProtocolError struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	RetryAfter int    `json:"retry_after,omitempty"`
}

func NewMessageStart(messageID, model string, createdAt int64) ProtocolEvent {
	return ProtocolEvent{
		Type:      "message_start",
		MessageID: messageID,
		Model:     model,
		Role:      "assistant",
		CreatedAt: createdAt,
	}
}

func NewContentBlockStartText(index int) ProtocolEvent {
	return ProtocolEvent{
		Type:         "content_block_start",
		Index:        intPointer(index),
		ContentBlock: map[string]any{"type": "text"},
	}
}

func NewContentBlockStartThinking(index int) ProtocolEvent {
	return ProtocolEvent{
		Type:         "content_block_start",
		Index:        intPointer(index),
		ContentBlock: map[string]any{"type": "thinking"},
	}
}

func NewContentBlockDeltaText(index int, text string) ProtocolEvent {
	return ProtocolEvent{
		Type:  "content_block_delta",
		Index: intPointer(index),
		Delta: map[string]any{"type": "text_delta", "text": text},
	}
}

func NewContentBlockDeltaThinking(index int, text string) ProtocolEvent {
	return ProtocolEvent{
		Type:  "content_block_delta",
		Index: intPointer(index),
		Delta: map[string]any{"type": "thinking_delta", "text": text},
	}
}

func NewContentBlockStop(index int) ProtocolEvent {
	return ProtocolEvent{Type: "content_block_stop", Index: intPointer(index)}
}

func NewMessageDelta(usage Usage, stopReason string) ProtocolEvent {
	return ProtocolEvent{Type: "message_delta", Usage: &usage, StopReason: stopReason}
}

func NewMessageStop() ProtocolEvent {
	return ProtocolEvent{Type: "message_stop"}
}

func NewPing() ProtocolEvent {
	return ProtocolEvent{Type: "ping"}
}

func NewErrorEvent(code, message string, retryAfter int) ProtocolEvent {
	return ProtocolEvent{
		Type: "error",
		Error: &ProtocolError{
			Code:       code,
			Message:    message,
			RetryAfter: retryAfter,
		},
	}
}

func EncodeSSE(event any, entryID string) []byte {
	var buffer bytes.Buffer
	if entryID != "" {
		buffer.WriteString("id: ")
		buffer.WriteString(entryID)
		buffer.WriteByte('\n')
	}
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	buffer.WriteString("data: ")
	if err := encoder.Encode(event); err != nil {
		buffer.WriteString(`{"type":"error","error":{"code":"internal","message":"编码失败"}}`)
	}
	buffer.WriteString("\n")
	return buffer.Bytes()
}

func intPointer(value int) *int {
	return &value
}
