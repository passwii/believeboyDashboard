package store

import (
	"context"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/users"
)

var _ users.SessionRevocationStore = (*UserStore)(nil)

func (s *UserStore) RevokeSessions(
	ctx context.Context,
	input users.SessionRevocationInput,
) (int, error) {
	fullDB, ok := s.db.(FullDB)
	if !ok {
		return 0, users.ErrSessionRevocationUnavailable
	}
	return revokeUserSessions(ctx, fullDB, input)
}
