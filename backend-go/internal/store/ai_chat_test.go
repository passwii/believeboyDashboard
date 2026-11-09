package store

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_chat"
)

func TestAIChatStoreListConversationsWithoutIdentitySkipsDatabase(t *testing.T) {
	db := &aiChatFakeDB{}
	store := NewAIChatStore(db)

	rows, err := store.ListConversations(context.Background(), nil)
	if err != nil {
		t.Fatalf("ListConversations() error = %v", err)
	}
	if len(rows) != 0 {
		t.Errorf("rows = %#v, want empty", rows)
	}
	if len(db.queryCalls) != 0 {
		t.Errorf("query calls = %d, want 0", len(db.queryCalls))
	}
}

func TestAIChatStoreGetConversationMapsNoRowsToNotFound(t *testing.T) {
	userID := int64(42)
	db := &aiChatFakeDB{row: aiChatFakeRow{err: pgx.ErrNoRows}}
	store := NewAIChatStore(db)

	conversation, err := store.GetConversation(context.Background(), 7, &userID)
	if !errors.Is(err, ai_chat.ErrNotFound) {
		t.Fatalf("GetConversation() error = %v, want ErrNotFound", err)
	}
	if conversation != nil {
		t.Errorf("conversation = %#v, want nil", conversation)
	}
	if len(db.queryRowCalls) != 1 {
		t.Fatalf("query row calls = %d, want 1", len(db.queryRowCalls))
	}
	if got := db.queryRowCalls[0].args; len(got) != 2 || got[0] != int64(7) || got[1] != userID {
		t.Errorf("query args = %#v, want conversation/user id", got)
	}
}

func TestAIChatStoreGetConversationScansOwnedRow(t *testing.T) {
	userID := int64(42)
	createdAt := time.Date(2026, 11, 1, 2, 3, 4, 123000000, time.UTC)
	db := &aiChatFakeDB{row: aiChatFakeRow{values: []any{
		int64(7), pgtype.Int8{Int64: 42, Valid: true}, "标题", createdAt, createdAt, 11, 22, 33,
	}}}
	store := NewAIChatStore(db)

	conversation, err := store.GetConversation(context.Background(), 7, &userID)
	if err != nil {
		t.Fatalf("GetConversation() error = %v", err)
	}
	if conversation == nil || conversation.ID != 7 || conversation.UserID == nil ||
		*conversation.UserID != 42 || conversation.Title != "标题" ||
		conversation.TotalTokens != 33 {
		t.Errorf("conversation = %#v", conversation)
	}
}

func TestAIChatStoreIntegrationCRUDAndUsage(t *testing.T) {
	databaseURL := os.Getenv("GO_API_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("set GO_API_TEST_DATABASE_URL to a BLF_test connection")
	}
	ctx := context.Background()
	pool, err := OpenPool(ctx, databaseURL)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	defer pool.Close()
	db := NewPGXDB(pool)
	store := NewAIChatStore(db)
	usageStore := NewAIChatUsageStore(db)
	userID := time.Now().UnixNano()
	t.Cleanup(func() {
		_, _ = db.Exec(context.Background(),
			`delete from public.ai_conversations where user_id = $1`, userID)
		_, _ = db.Exec(context.Background(),
			`delete from public.ai_chat_token_usage_snapshots where user_id = $1`, userID)
	})

	conversation, err := store.CreateConversation(ctx, "integration", userID)
	if err != nil {
		t.Fatalf("CreateConversation() error = %v", err)
	}
	userMessage, assistantMessage, err := store.AppendTurn(
		ctx,
		conversation.ID,
		&userID,
		"hello",
		"model-a",
	)
	if err != nil {
		t.Fatalf("AppendTurn() error = %v", err)
	}
	if userMessage.ID == 0 || assistantMessage.ID == 0 {
		t.Fatalf("append ids = %d/%d", userMessage.ID, assistantMessage.ID)
	}
	replacement, err := store.ReplaceAssistant(
		ctx,
		conversation.ID,
		&userID,
		assistantMessage.ID,
		"model-a",
	)
	if err != nil {
		t.Fatalf("ReplaceAssistant() error = %v", err)
	}
	sources := `[{"title":"source","url":"https://example.com"}]`
	timeRange := "month"
	finalized, updatedConversation, err := store.FinalizeAssistant(
		ctx,
		ai_chat.FinalizeInput{
			ConversationID:     conversation.ID,
			AssistantMessageID: replacement.ID,
			UserID:             &userID,
			Content:            "final answer",
			SearchSourcesJSON:  &sources,
			SearchTimeRange:    &timeRange,
			PromptTokens:       3,
			CompletionTokens:   4,
			TotalTokens:        7,
			DurationMS:         120,
			Complete:           true,
		},
	)
	if err != nil {
		t.Fatalf("FinalizeAssistant() error = %v", err)
	}
	if finalized.Content != "final answer" || !finalized.IsComplete ||
		finalized.TotalTokens != 7 || finalized.Model != "model-a" {
		t.Errorf("finalized message = %#v", finalized)
	}
	if updatedConversation.TotalTokens != 7 {
		t.Errorf("conversation totals = %#v", updatedConversation)
	}
	_, idempotentConversation, err := store.FinalizeAssistant(
		ctx,
		ai_chat.FinalizeInput{
			ConversationID:     conversation.ID,
			AssistantMessageID: replacement.ID,
			UserID:             &userID,
			Content:            "final answer",
			SearchSourcesJSON:  &sources,
			SearchTimeRange:    &timeRange,
			PromptTokens:       3,
			CompletionTokens:   4,
			TotalTokens:        7,
			DurationMS:         120,
			Complete:           true,
		},
	)
	if err != nil || idempotentConversation.TotalTokens != 7 {
		t.Fatalf("idempotent finalize = %#v, %v", idempotentConversation, err)
	}
	messages, err := store.ListMessages(ctx, conversation.ID, &userID)
	if err != nil {
		t.Fatalf("ListMessages() error = %v", err)
	}
	if len(messages) != 2 {
		t.Errorf("messages = %#v, want user + assistant", messages)
	}
	updatedMessage, err := store.UpdateMessage(ctx, conversation.ID, userMessage.ID, &userID, "hello updated")
	if err != nil {
		t.Fatalf("UpdateMessage() error = %v", err)
	}
	if updatedMessage.Content != "hello updated" {
		t.Errorf("updated message = %#v", updatedMessage)
	}
	fetched, err := store.GetConversation(ctx, conversation.ID, &userID)
	if err != nil || fetched == nil {
		t.Fatalf("GetConversation() = %#v, %v", fetched, err)
	}
	if _, err := store.DeleteMessage(ctx, conversation.ID, userMessage.ID, &userID); err != nil {
		t.Fatalf("DeleteMessage() error = %v", err)
	}

	dataDate := time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC)
	_, err = db.Exec(
		ctx,
		`insert into public.ai_chat_token_usage_snapshots (
		   user_id, data_date, model, prompt_tokens, completion_tokens,
		   total_tokens, message_count, conversation_count, data_version
		 ) values ($1, $2, 'model-a', 3, 4, 7, 2, 1, 1)
		 on conflict (user_id, data_date, model) do update
		 set prompt_tokens = excluded.prompt_tokens,
		     completion_tokens = excluded.completion_tokens,
		     total_tokens = excluded.total_tokens,
		     message_count = excluded.message_count,
		     conversation_count = excluded.conversation_count,
		     computed_at = now()`,
		userID,
		dataDate,
	)
	if err != nil {
		t.Fatalf("insert usage snapshot: %v", err)
	}
	snapshots, err := usageStore.ListSnapshots(ctx, userID, dataDate, dataDate)
	if err != nil {
		t.Fatalf("ListSnapshots() error = %v", err)
	}
	if len(snapshots) != 1 || snapshots[0].TotalTokens != 7 {
		t.Errorf("snapshots = %#v", snapshots)
	}
	freshness, err := usageStore.Freshness(ctx)
	if err != nil || freshness.LatestComputedAt == nil {
		t.Errorf("Freshness() = %#v, %v", freshness, err)
	}

	deleted, err := store.DeleteConversation(ctx, conversation.ID, &userID)
	if err != nil || !deleted {
		t.Fatalf("DeleteConversation() = %t, %v", deleted, err)
	}
}

type aiChatQueryCall struct {
	sql  string
	args []any
}

type aiChatFakeDB struct {
	row           pgx.Row
	queryCalls    []aiChatQueryCall
	queryRowCalls []aiChatQueryCall
}

func (db *aiChatFakeDB) Query(
	_ context.Context,
	sql string,
	args ...any,
) (Rows, error) {
	db.queryCalls = append(db.queryCalls, aiChatQueryCall{sql: sql, args: args})
	return nil, nil
}

func (db *aiChatFakeDB) QueryRow(
	_ context.Context,
	sql string,
	args ...any,
) pgx.Row {
	db.queryRowCalls = append(db.queryRowCalls, aiChatQueryCall{sql: sql, args: args})
	return db.row
}

func (*aiChatFakeDB) Ping(context.Context) error {
	return nil
}

func (*aiChatFakeDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (db *aiChatFakeDB) Begin(context.Context) (pgx.Tx, error) {
	return &aiChatFakeTx{fakeDB: db}, nil
}

type aiChatFakeRow struct {
	values []any
	err    error
}

func (row aiChatFakeRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	if len(dest) != len(row.values) {
		return fmt.Errorf("scan dest count = %d, want %d", len(dest), len(row.values))
	}
	for index, value := range row.values {
		switch target := dest[index].(type) {
		case *int64:
			number, ok := value.(int64)
			if !ok {
				return fmt.Errorf("value %d is %T, want int64", index, value)
			}
			*target = number
		case *int:
			number, ok := value.(int)
			if !ok {
				if number64, ok := value.(int64); ok {
					*target = int(number64)
					continue
				}
				return fmt.Errorf("value %d is %T, want int", index, value)
			}
			*target = number
		case *string:
			text, ok := value.(string)
			if !ok {
				return fmt.Errorf("value %d is %T, want string", index, value)
			}
			*target = text
		case *time.Time:
			timestamp, ok := value.(time.Time)
			if !ok {
				return fmt.Errorf("value %d is %T, want time.Time", index, value)
			}
			*target = timestamp
		case *pgtype.Int8:
			number, ok := value.(pgtype.Int8)
			if !ok {
				return fmt.Errorf("value %d is %T, want pgtype.Int8", index, value)
			}
			*target = number
		default:
			return fmt.Errorf("unsupported scan dest %T", dest[index])
		}
	}
	return nil
}

type aiChatFakeTx struct {
	fakeDB *aiChatFakeDB
}

func (*aiChatFakeTx) Commit(context.Context) error   { return nil }
func (*aiChatFakeTx) Rollback(context.Context) error { return nil }
func (*aiChatFakeTx) CopyFrom(
	context.Context,
	pgx.Identifier,
	[]string,
	pgx.CopyFromSource,
) (int64, error) {
	return 0, nil
}
func (*aiChatFakeTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults { return nil }
func (*aiChatFakeTx) LargeObjects() pgx.LargeObjects                         { return pgx.LargeObjects{} }
func (*aiChatFakeTx) Prepare(
	context.Context,
	string,
	string,
) (*pgconn.StatementDescription, error) {
	return nil, nil
}
func (*aiChatFakeTx) Conn() *pgx.Conn { return nil }
func (*aiChatFakeTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, nil
}
func (tx *aiChatFakeTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return tx.fakeDB.QueryRow(ctx, sql, args...)
}
func (tx *aiChatFakeTx) Exec(
	ctx context.Context,
	sql string,
	args ...any,
) (pgconn.CommandTag, error) {
	return tx.fakeDB.Exec(ctx, sql, args...)
}
func (tx *aiChatFakeTx) Begin(context.Context) (pgx.Tx, error) { return tx, nil }

var _ FullDB = (*aiChatFakeDB)(nil)
var _ pgx.Tx = (*aiChatFakeTx)(nil)
