package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_chat"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ai_chat_usage"
)

type AIChatStore struct {
	db FullDB
}

func NewAIChatStore(db FullDB) *AIChatStore {
	return &AIChatStore{db: db}
}

type AIChatUsageStore struct {
	db FullDB
}

func NewAIChatUsageStore(db FullDB) *AIChatUsageStore {
	return &AIChatUsageStore{db: db}
}

const aiConversationColumns = `
	id, user_id, title, created_at, updated_at,
	coalesce(total_prompt_tokens, 0),
	coalesce(total_completion_tokens, 0),
	coalesce(total_tokens, 0)`

const aiMessageColumns = `
	id, conversation_id, role, content, search_sources,
	search_time_range, coalesce(is_complete, false),
	coalesce(prompt_tokens, 0), coalesce(completion_tokens, 0),
	coalesce(total_tokens, 0), duration_ms,
	coalesce(model, 'unknown'), created_at`

func (store *AIChatStore) ListConversations(
	ctx context.Context,
	userID *int64,
) ([]ai_chat.Conversation, error) {
	if userID == nil {
		return []ai_chat.Conversation{}, nil
	}
	rows, err := store.db.Query(
		ctx,
		`select `+aiConversationColumns+`
		 from public.ai_conversations
		 where user_id = $1
		 order by updated_at desc, id desc`,
		*userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]ai_chat.Conversation, 0)
	for rows.Next() {
		item, err := scanAIConversationRows(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (store *AIChatStore) CreateConversation(
	ctx context.Context,
	title string,
	userID int64,
) (ai_chat.Conversation, error) {
	row := store.db.QueryRow(
		ctx,
		`insert into public.ai_conversations (
		   user_id, title, total_prompt_tokens, total_completion_tokens, total_tokens
		 )
		 values ($1, $2, 0, 0, 0)
		 returning `+aiConversationColumns,
		userID,
		title,
	)
	return scanAIConversationRow(row)
}

func (store *AIChatStore) GetConversation(
	ctx context.Context,
	conversationID int64,
	userID *int64,
) (*ai_chat.Conversation, error) {
	if userID == nil {
		return nil, ai_chat.ErrNotFound
	}
	row := store.db.QueryRow(
		ctx,
		`select `+aiConversationColumns+`
		 from public.ai_conversations
		 where id = $1 and user_id = $2
		 limit 1`,
		conversationID,
		*userID,
	)
	item, err := scanAIConversationRow(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ai_chat.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (store *AIChatStore) UpdateConversation(
	ctx context.Context,
	conversationID int64,
	userID *int64,
	title *string,
) (ai_chat.Conversation, error) {
	if userID == nil {
		return ai_chat.Conversation{}, ai_chat.ErrNotFound
	}
	row := store.db.QueryRow(
		ctx,
		`update public.ai_conversations
		 set title = coalesce($3::text, title),
		     updated_at = now()
		 where id = $1 and user_id = $2
		 returning `+aiConversationColumns,
		conversationID,
		*userID,
		aiChatNullableString(title),
	)
	item, err := scanAIConversationRow(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return ai_chat.Conversation{}, ai_chat.ErrNotFound
	}
	return item, err
}

func (store *AIChatStore) DeleteConversation(
	ctx context.Context,
	conversationID int64,
	userID *int64,
) (bool, error) {
	if userID == nil {
		return false, nil
	}
	tag, err := store.db.Exec(
		ctx,
		`delete from public.ai_conversations
		 where id = $1 and user_id = $2`,
		conversationID,
		*userID,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (store *AIChatStore) ListMessages(
	ctx context.Context,
	conversationID int64,
	userID *int64,
) ([]ai_chat.Message, error) {
	if userID == nil {
		return []ai_chat.Message{}, nil
	}
	rows, err := store.db.Query(
		ctx,
		`select `+prefixedAIMessageColumns("m")+`
		 from public.ai_messages m
		 join public.ai_conversations c on c.id = m.conversation_id
		 where m.conversation_id = $1 and c.user_id = $2
		 order by m.created_at asc, m.id asc`,
		conversationID,
		*userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]ai_chat.Message, 0)
	for rows.Next() {
		item, err := scanAIMessageRows(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (store *AIChatStore) GetMessage(
	ctx context.Context,
	conversationID int64,
	messageID int64,
	userID *int64,
) (*ai_chat.Message, error) {
	if userID == nil {
		return nil, ai_chat.ErrNotFound
	}
	row := store.db.QueryRow(
		ctx,
		`select `+prefixedAIMessageColumns("m")+`
		 from public.ai_messages m
		 join public.ai_conversations c on c.id = m.conversation_id
		 where m.conversation_id = $1 and m.id = $2 and c.user_id = $3
		 limit 1`,
		conversationID,
		messageID,
		*userID,
	)
	item, err := scanAIMessageRow(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ai_chat.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (store *AIChatStore) UpdateMessage(
	ctx context.Context,
	conversationID int64,
	messageID int64,
	userID *int64,
	content string,
) (ai_chat.Message, error) {
	if userID == nil {
		return ai_chat.Message{}, ai_chat.ErrNotFound
	}
	var result ai_chat.Message
	err := RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		row := tx.QueryRow(
			ctx,
			`update public.ai_messages m
			 set content = $4,
			     is_complete = true
			 from public.ai_conversations c
			 where m.conversation_id = $1 and m.id = $2
			   and c.id = m.conversation_id and c.user_id = $3
			 returning `+prefixedAIMessageColumns("m"),
			conversationID,
			messageID,
			*userID,
			content,
		)
		var err error
		result, err = scanAIMessageRow(row)
		if err != nil {
			return err
		}
		_, err = tx.Exec(
			ctx,
			`update public.ai_conversations set updated_at = now() where id = $1`,
			conversationID,
		)
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return ai_chat.Message{}, ai_chat.ErrNotFound
	}
	return result, err
}

func (store *AIChatStore) DeleteMessage(
	ctx context.Context,
	conversationID int64,
	messageID int64,
	userID *int64,
) (bool, error) {
	if userID == nil {
		return false, nil
	}
	tag, err := store.db.Exec(
		ctx,
		`delete from public.ai_messages m
		 using public.ai_conversations c
		 where m.conversation_id = $1 and m.id = $2
		   and c.id = m.conversation_id and c.user_id = $3`,
		conversationID,
		messageID,
		*userID,
	)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

func (store *AIChatStore) AppendTurn(
	ctx context.Context,
	conversationID int64,
	userID *int64,
	userContent string,
	assistantModel string,
) (ai_chat.Message, ai_chat.Message, error) {
	if userID == nil {
		return ai_chat.Message{}, ai_chat.Message{}, ai_chat.ErrNotFound
	}
	var userRow ai_chat.Message
	var assistantRow ai_chat.Message
	err := RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		if err := lockAIConversation(ctx, tx, conversationID, *userID); err != nil {
			return err
		}
		var err error
		userRow, err = scanAIMessageRow(tx.QueryRow(
			ctx,
			`insert into public.ai_messages (
			   conversation_id, role, content, is_complete, model
			 )
			 values ($1, 'user', $2, true, 'unknown')
			 returning `+aiMessageColumns,
			conversationID,
			userContent,
		))
		if err != nil {
			return err
		}
		assistantRow, err = scanAIMessageRow(tx.QueryRow(
			ctx,
			`insert into public.ai_messages (
			   conversation_id, role, content, is_complete, model
			 )
			 values ($1, 'assistant', '', false, $2)
			 returning `+aiMessageColumns,
			conversationID,
			assistantModel,
		))
		if err != nil {
			return err
		}
		_, err = tx.Exec(
			ctx,
			`update public.ai_conversations set updated_at = now() where id = $1`,
			conversationID,
		)
		return err
	})
	return userRow, assistantRow, err
}

func (store *AIChatStore) ReplaceAssistant(
	ctx context.Context,
	conversationID int64,
	userID *int64,
	targetMessageID int64,
	assistantModel string,
) (ai_chat.Message, error) {
	if userID == nil {
		return ai_chat.Message{}, ai_chat.ErrNotFound
	}
	var assistantRow ai_chat.Message
	err := RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		if err := lockAIConversation(ctx, tx, conversationID, *userID); err != nil {
			return err
		}
		tag, err := tx.Exec(
			ctx,
			`delete from public.ai_messages
			 where id = $1 and conversation_id = $2 and role = 'assistant'`,
			targetMessageID,
			conversationID,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ai_chat.ErrNotFound
		}
		assistantRow, err = scanAIMessageRow(tx.QueryRow(
			ctx,
			`insert into public.ai_messages (
			   conversation_id, role, content, is_complete, model
			 )
			 values ($1, 'assistant', '', false, $2)
			 returning `+aiMessageColumns,
			conversationID,
			assistantModel,
		))
		if err != nil {
			return err
		}
		_, err = tx.Exec(
			ctx,
			`update public.ai_conversations set updated_at = now() where id = $1`,
			conversationID,
		)
		return err
	})
	return assistantRow, err
}

func (store *AIChatStore) FinalizeAssistant(
	ctx context.Context,
	input ai_chat.FinalizeInput,
) (*ai_chat.Message, *ai_chat.Conversation, error) {
	if input.UserID == nil {
		return nil, nil, ai_chat.ErrNotFound
	}
	var message ai_chat.Message
	var conversation ai_chat.Conversation
	err := RunInTx(ctx, store.db, func(tx pgx.Tx) error {
		if err := lockAIConversation(ctx, tx, input.ConversationID, *input.UserID); err != nil {
			return err
		}
		var err error
		message, err = scanAIMessageRow(tx.QueryRow(
			ctx,
			`update public.ai_messages
			 set content = $3,
			     search_sources = $4,
			     search_time_range = $5,
			     is_complete = $6,
			     prompt_tokens = $7,
			     completion_tokens = $8,
			     total_tokens = $9,
			     duration_ms = $10
			 where id = $1 and conversation_id = $2 and role = 'assistant'
			 returning `+aiMessageColumns,
			input.AssistantMessageID,
			input.ConversationID,
			input.Content,
			aiChatNullableString(input.SearchSourcesJSON),
			aiChatNullableString(input.SearchTimeRange),
			input.Complete,
			input.PromptTokens,
			input.CompletionTokens,
			input.TotalTokens,
			input.DurationMS,
		))
		if err != nil {
			return err
		}
		conversation, err = scanAIConversationRow(tx.QueryRow(
			ctx,
			`update public.ai_conversations c
			 set updated_at = now(),
			     total_prompt_tokens = coalesce((
			       select sum(m.prompt_tokens) from public.ai_messages m
			       where m.conversation_id = c.id
			     ), 0),
			     total_completion_tokens = coalesce((
			       select sum(m.completion_tokens) from public.ai_messages m
			       where m.conversation_id = c.id
			     ), 0),
			     total_tokens = coalesce((
			       select sum(m.total_tokens) from public.ai_messages m
			       where m.conversation_id = c.id
			     ), 0)
			 where c.id = $1
			 returning `+aiConversationColumns,
			input.ConversationID,
		))
		return err
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, ai_chat.ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	return &message, &conversation, nil
}

func lockAIConversation(
	ctx context.Context,
	tx pgx.Tx,
	conversationID int64,
	userID int64,
) error {
	var id int64
	err := tx.QueryRow(
		ctx,
		`select id from public.ai_conversations
		 where id = $1 and user_id = $2
		 for update`,
		conversationID,
		userID,
	).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ai_chat.ErrNotFound
	}
	if err != nil {
		return err
	}
	return nil
}

func scanAIConversationRow(row pgx.Row) (ai_chat.Conversation, error) {
	var (
		item   ai_chat.Conversation
		userID pgtype.Int8
	)
	err := row.Scan(
		&item.ID,
		&userID,
		&item.Title,
		&item.CreatedAt,
		&item.UpdatedAt,
		&item.TotalPromptTokens,
		&item.TotalCompletionTokens,
		&item.TotalTokens,
	)
	if err != nil {
		return ai_chat.Conversation{}, err
	}
	if userID.Valid {
		value := userID.Int64
		item.UserID = &value
	}
	return item, nil
}

func scanAIConversationRows(rows Rows) (ai_chat.Conversation, error) {
	var (
		item   ai_chat.Conversation
		userID pgtype.Int8
	)
	err := rows.Scan(
		&item.ID,
		&userID,
		&item.Title,
		&item.CreatedAt,
		&item.UpdatedAt,
		&item.TotalPromptTokens,
		&item.TotalCompletionTokens,
		&item.TotalTokens,
	)
	if err != nil {
		return ai_chat.Conversation{}, err
	}
	if userID.Valid {
		value := userID.Int64
		item.UserID = &value
	}
	return item, nil
}

func scanAIMessageRow(row pgx.Row) (ai_chat.Message, error) {
	var (
		item       ai_chat.Message
		sources    pgtype.Text
		timeRange  pgtype.Text
		durationMS pgtype.Int4
	)
	err := row.Scan(
		&item.ID,
		&item.ConversationID,
		&item.Role,
		&item.Content,
		&sources,
		&timeRange,
		&item.IsComplete,
		&item.PromptTokens,
		&item.CompletionTokens,
		&item.TotalTokens,
		&durationMS,
		&item.Model,
		&item.CreatedAt,
	)
	if err != nil {
		return ai_chat.Message{}, err
	}
	item.SearchSources = Text(sources)
	item.SearchTimeRange = Text(timeRange)
	if durationMS.Valid {
		value := int(durationMS.Int32)
		item.DurationMS = &value
	}
	return item, nil
}

func scanAIMessageRows(rows Rows) (ai_chat.Message, error) {
	var (
		item       ai_chat.Message
		sources    pgtype.Text
		timeRange  pgtype.Text
		durationMS pgtype.Int4
	)
	err := rows.Scan(
		&item.ID,
		&item.ConversationID,
		&item.Role,
		&item.Content,
		&sources,
		&timeRange,
		&item.IsComplete,
		&item.PromptTokens,
		&item.CompletionTokens,
		&item.TotalTokens,
		&durationMS,
		&item.Model,
		&item.CreatedAt,
	)
	if err != nil {
		return ai_chat.Message{}, err
	}
	item.SearchSources = Text(sources)
	item.SearchTimeRange = Text(timeRange)
	if durationMS.Valid {
		value := int(durationMS.Int32)
		item.DurationMS = &value
	}
	return item, nil
}

func prefixedAIMessageColumns(alias string) string {
	return fmt.Sprintf(`
		%s.id, %s.conversation_id, %s.role, %s.content,
		%s.search_sources, %s.search_time_range,
		coalesce(%s.is_complete, false),
		coalesce(%s.prompt_tokens, 0), coalesce(%s.completion_tokens, 0),
		coalesce(%s.total_tokens, 0), %s.duration_ms,
		coalesce(%s.model, 'unknown'), %s.created_at`,
		alias, alias, alias, alias, alias, alias, alias, alias, alias, alias, alias, alias, alias,
	)
}

func aiChatNullableString(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func (store *AIChatUsageStore) ListSnapshots(
	ctx context.Context,
	userID int64,
	startDate time.Time,
	endDate time.Time,
) ([]ai_chat_usage.SnapshotRow, error) {
	rows, err := store.db.Query(
		ctx,
		`select data_date, model, coalesce(prompt_tokens, 0),
		        coalesce(completion_tokens, 0), coalesce(total_tokens, 0),
		        coalesce(message_count, 0), coalesce(conversation_count, 0)
		 from public.ai_chat_token_usage_snapshots
		 where user_id = $1 and data_date >= $2 and data_date <= $3
		 order by data_date asc, model asc`,
		userID,
		startDate,
		endDate,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]ai_chat_usage.SnapshotRow, 0)
	for rows.Next() {
		var item ai_chat_usage.SnapshotRow
		if err := rows.Scan(
			&item.DataDate,
			&item.Model,
			&item.PromptTokens,
			&item.CompletionTokens,
			&item.TotalTokens,
			&item.MessageCount,
			&item.ConversationCount,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (store *AIChatUsageStore) Freshness(
	ctx context.Context,
) (ai_chat_usage.Freshness, error) {
	var dataDate time.Time
	var computedAt time.Time
	err := store.db.QueryRow(
		ctx,
		`select data_date, computed_at
		 from public.ai_chat_token_usage_snapshots
		 order by computed_at desc
		 limit 1`,
	).Scan(&dataDate, &computedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ai_chat_usage.Freshness{}, nil
	}
	if err != nil {
		return ai_chat_usage.Freshness{}, err
	}
	return ai_chat_usage.Freshness{
		LatestDataDate:   &dataDate,
		LatestComputedAt: &computedAt,
	}, nil
}
