package ai_chat

import (
	"context"
	"errors"
	"testing"
)

func TestResolveChatModelFallsBackPastBlockedDefault(t *testing.T) {
	cfg := testAIChatConfig()
	cfg.AIChatDefaultModel = "blocked-default"
	cfg.AIChatModelBlocklist = "blocked-default"
	provider := &fakeAIProvider{models: []string{"blocked-default", "allowed"}}
	model, effort, err := ResolveChatModel(context.Background(), provider, cfg, "", "")
	if err != nil {
		t.Fatalf("ResolveChatModel() error = %v", err)
	}
	if model != "allowed" || effort != "" {
		t.Errorf("model/effort = %q/%q", model, effort)
	}
}

func TestResolveChatModelRejectsArbitraryModelWhenListFails(t *testing.T) {
	cfg := testAIChatConfig()
	provider := &fakeAIProvider{modelErr: errors.New("models endpoint unavailable")}
	if _, _, err := ResolveChatModel(context.Background(), provider, cfg, "arbitrary", ""); !errors.Is(err, ErrModelNotAllowed) {
		t.Fatalf("error = %v, want ErrModelNotAllowed", err)
	}
}
