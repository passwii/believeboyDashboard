package projects

import (
	"context"
	"errors"
	"testing"

	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
)

func TestAIContextParserDecodesStructuredJSON(t *testing.T) {
	provider := &stage10EContextProvider{
		content: "```json\n{\"工厂供货\":\"月产能 5000 件\",\"风险备注\":\"交期可能延误\"}\n```",
	}
	parser := NewAIContextParser(provider, "model-a")
	result, err := parser.Parse(context.Background(), "深圳工厂月产能 5000 件，交期有风险")
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if result["工厂供货"] != "月产能 5000 件" || result["风险备注"] != "交期可能延误" {
		t.Fatalf("result = %#v", result)
	}
	if provider.request.Model != "model-a" {
		t.Errorf("model = %q, want model-a", provider.request.Model)
	}
	if len(provider.request.Messages) != 2 ||
		provider.request.Messages[0].Role != "system" ||
		provider.request.Messages[1].Role != "user" {
		t.Fatalf("messages = %#v, want system + user", provider.request.Messages)
	}
}

func TestAIContextParserFailsClosedForUnconfiguredProvider(t *testing.T) {
	parser := NewAIContextParser(&stage10EContextProvider{configured: false}, "model-a")
	_, err := parser.Parse(context.Background(), "project context")
	if !errors.Is(err, ErrContextParserUnavailable) {
		t.Fatalf("Parse() error = %v, want ErrContextParserUnavailable", err)
	}
}

func TestAIContextParserRejectsNonObjectOutput(t *testing.T) {
	parser := NewAIContextParser(&stage10EContextProvider{content: `["not-an-object"]`}, "model-a")
	_, err := parser.Parse(context.Background(), "project context")
	if err == nil {
		t.Fatal("Parse() error = nil, want invalid JSON object error")
	}
}

type stage10EContextProvider struct {
	configured bool
	content    string
	err        error
	request    ai.ChatRequest
}

func (p *stage10EContextProvider) Configured() bool {
	if p == nil {
		return false
	}
	return p.configured || p.content != ""
}

func (*stage10EContextProvider) AvailableModels(context.Context) ([]string, error) {
	return []string{"model-a"}, nil
}

func (p *stage10EContextProvider) Complete(_ context.Context, request ai.ChatRequest) (string, ai.Usage, error) {
	p.request = request
	return p.content, ai.Usage{}, p.err
}

func (*stage10EContextProvider) Stream(context.Context, ai.ChatRequest, func(ai.Chunk) error) (ai.Usage, error) {
	return ai.Usage{}, errors.New("not implemented")
}

var _ ai.Provider = (*stage10EContextProvider)(nil)
