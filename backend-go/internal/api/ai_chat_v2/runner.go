package ai_chat_v2

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log"
	"net"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/ai"
)

var errEmptyStreamResponse = errors.New("ai provider returned no content")

type Runner struct {
	backend      ai.StreamBackend
	provider     ai.Provider
	pollInterval time.Duration
}

func NewRunner(backend ai.StreamBackend, provider ai.Provider) *Runner {
	return &Runner{
		backend:      backend,
		provider:     provider,
		pollInterval: 100 * time.Millisecond,
	}
}

func (runner *Runner) Run(ctx context.Context, input RunInput) {
	defer func() {
		_ = runner.backend.End(context.Background(), input.ConversationID)
	}()
	defer func() {
		if recovered := recover(); recovered != nil {
			log.Printf("ai chat v2 runner panic conversation %d: %v", input.ConversationID, recovered)
			_, _ = runner.backend.Append(
				context.Background(),
				input.ConversationID,
				"event",
				ai.NewErrorEvent("internal", "内部错误", 0),
			)
			_, _ = runner.backend.Append(
				context.Background(),
				input.ConversationID,
				"event",
				ai.NewMessageStop(),
			)
		}
	}()

	runContext, cancel := context.WithCancel(ctx)
	watchDone := make(chan struct{})
	defer func() {
		cancel()
		<-watchDone
	}()
	go func() {
		defer close(watchDone)
		ticker := time.NewTicker(runner.pollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-runContext.Done():
				return
			case <-ticker.C:
				live, err := runner.backend.IsLive(runContext, input.ConversationID)
				if err != nil || !live {
					cancel()
					return
				}
			}
		}
	}()

	start := time.Now()
	createdAt := start.UnixMilli()
	if _, err := runner.backend.Append(
		runContext,
		input.ConversationID,
		"event",
		ai.NewMessageStart(randomMessageID(), input.Model, createdAt),
	); err != nil {
		return
	}

	currentBlock := -1
	nextBlock := 0
	currentType := ""
	var textBuilder []byte
	chunkSeen := false
	providerUsage := ai.Usage{}
	streamModel := func(model string) (ai.Usage, error) {
		streamUsage, providerErr := runner.provider.Stream(
			runContext,
			ai.ChatRequest{
				Model:           model,
				Messages:        input.Messages,
				ReasoningEffort: input.ReasoningEffort,
				Temperature:     0.7,
			},
			func(chunk ai.Chunk) error {
				if chunk.Type == ai.ChunkUsage {
					if chunk.Usage != nil {
						providerUsage = *chunk.Usage
					}
					return nil
				}
				chunkSeen = true
				if err := runContext.Err(); err != nil {
					return err
				}
				blockType := "text"
				if chunk.Type == ai.ChunkThinking {
					blockType = "thinking"
				}
				if currentBlock < 0 || currentType != blockType {
					if currentBlock >= 0 {
						_, _ = runner.backend.Append(
							runContext,
							input.ConversationID,
							"event",
							ai.NewContentBlockStop(currentBlock),
						)
					}
					currentBlock = nextBlock
					nextBlock++
					currentType = blockType
					var startEvent ai.ProtocolEvent
					if blockType == "thinking" {
						startEvent = ai.NewContentBlockStartThinking(currentBlock)
					} else {
						startEvent = ai.NewContentBlockStartText(currentBlock)
					}
					if _, err := runner.backend.Append(
						runContext,
						input.ConversationID,
						"event",
						startEvent,
					); err != nil {
						return err
					}
				}
				var delta ai.ProtocolEvent
				if chunk.Type == ai.ChunkThinking {
					delta = ai.NewContentBlockDeltaThinking(currentBlock, chunk.Text)
				} else {
					textBuilder = append(textBuilder, chunk.Text...)
					delta = ai.NewContentBlockDeltaText(currentBlock, chunk.Text)
				}
				_, err := runner.backend.Append(
					runContext,
					input.ConversationID,
					"event",
					delta,
				)
				return err
			},
		)
		if providerUsage == (ai.Usage{}) {
			providerUsage = streamUsage
		}
		return streamUsage, providerErr
	}
	streamUsage, providerErr := streamModel(input.Model)
	if providerErr != nil &&
		!chunkSeen &&
		input.BackupModel != "" &&
		input.BackupModel != input.Model &&
		runContext.Err() == nil {
		providerUsage = ai.Usage{}
		_, providerErr = streamModel(input.BackupModel)
	}
	if providerUsage == (ai.Usage{}) {
		providerUsage = streamUsage
	}
	fullText := strings.TrimSpace(string(textBuilder))
	if providerErr == nil && fullText == "" {
		providerErr = errEmptyStreamResponse
	}
	if currentBlock >= 0 {
		_, _ = runner.backend.Append(
			context.Background(),
			input.ConversationID,
			"event",
			ai.NewContentBlockStop(currentBlock),
		)
	}

	duration := int(time.Since(start).Milliseconds())
	result := RunResult{
		FullText:   fullText,
		Usage:      providerUsage,
		DurationMS: maxInt(0, duration),
	}
	if providerErr == nil {
		result.StopReason = "end_turn"
		result.Complete = true
	} else {
		result.StopReason = "error"
		result.Complete = false
	}

	switch {
	case providerErr == nil:
		_, _ = runner.backend.Append(
			context.Background(),
			input.ConversationID,
			"event",
			ai.NewMessageDelta(providerUsage, "end_turn"),
		)
		done, finalizeErr := runner.finalize(input, result)
		if finalizeErr != nil {
			log.Printf("ai chat v2 finalize conversation %d: %v", input.ConversationID, finalizeErr)
			_, _ = runner.backend.Append(
				context.Background(),
				input.ConversationID,
				"event",
				ai.NewErrorEvent("persistence", "保存对话失败", 0),
			)
		} else if done != nil {
			_, _ = runner.backend.Append(
				context.Background(),
				input.ConversationID,
				"done",
				done,
			)
		}
	case errors.Is(providerErr, context.Canceled):
		result.StopReason = "cancelled"
		_, _ = runner.backend.Append(
			context.Background(),
			input.ConversationID,
			"event",
			ai.NewErrorEvent("cancelled", "用户取消", 0),
		)
		_, _ = runner.finalize(input, result)
	case errors.Is(providerErr, context.DeadlineExceeded):
		result.StopReason = "timeout"
		_, _ = runner.backend.Append(
			context.Background(),
			input.ConversationID,
			"event",
			ai.NewErrorEvent("timeout", "请求超时", 0),
		)
		_, _ = runner.finalize(input, result)
	default:
		code, message := classifyProviderError(providerErr)
		_, _ = runner.backend.Append(
			context.Background(),
			input.ConversationID,
			"event",
			ai.NewErrorEvent(code, message, retryAfter(providerErr)),
		)
		_, _ = runner.finalize(input, result)
	}
	_, _ = runner.backend.Append(
		context.Background(),
		input.ConversationID,
		"event",
		ai.NewMessageStop(),
	)
}

func (runner *Runner) finalize(
	input RunInput,
	result RunResult,
) (*DonePayload, error) {
	if input.Finalize == nil {
		return nil, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return input.Finalize(ctx, result)
}

func randomMessageID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "message-fallback"
	}
	return hex.EncodeToString(value[:])
}

func classifyProviderError(err error) (string, string) {
	if errors.Is(err, errEmptyStreamResponse) {
		return "llm_5xx", "模型未返回内容"
	}
	var providerErr *ai.ProviderError
	if errors.As(err, &providerErr) {
		switch {
		case providerErr.StatusCode == 429:
			return "rate_limit", "模型请求过于频繁"
		case providerErr.StatusCode >= 400 && providerErr.StatusCode < 500:
			return "llm_4xx", "模型请求失败"
		default:
			return "llm_5xx", "模型服务暂不可用"
		}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout", "请求超时"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "timeout", "请求超时"
	}
	return "internal", "内部错误"
}

func retryAfter(err error) int {
	var providerErr *ai.ProviderError
	if errors.As(err, &providerErr) {
		return providerErr.RetryAfter
	}
	return 0
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
