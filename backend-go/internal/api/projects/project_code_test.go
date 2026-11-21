package projects

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestValidateProjectCode(t *testing.T) {
	tests := []struct {
		name       string
		value      *string
		wantStatus int
		wantDetail string
	}{
		{name: "unassigned", value: nil},
		{name: "uppercase code", value: stringPointer("QUF")},
		{
			name:       "lowercase",
			value:      stringPointer("quf"),
			wantStatus: http.StatusUnprocessableEntity,
			wantDetail: "project_code must match ^[A-Z]{3}$",
		},
		{
			name:       "wrong length",
			value:      stringPointer("QU"),
			wantStatus: http.StatusUnprocessableEntity,
			wantDetail: "project_code must match ^[A-Z]{3}$",
		},
		{
			name:       "non letter",
			value:      stringPointer("Q1F"),
			wantStatus: http.StatusUnprocessableEntity,
			wantDetail: "project_code must match ^[A-Z]{3}$",
		},
		{
			name:       "reserved",
			value:      stringPointer("ALL"),
			wantStatus: http.StatusUnprocessableEntity,
			wantDetail: "project_code cannot be ALL",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := ValidateProjectCode(test.value)
			if test.wantStatus == 0 {
				if err != nil {
					t.Fatalf("ValidateProjectCode() error = %v, want nil", err)
				}
				return
			}
			status, detail := HTTPError(err)
			if status != test.wantStatus || detail != test.wantDetail {
				t.Fatalf("HTTPError() = (%d, %q), want (%d, %q)", status, detail, test.wantStatus, test.wantDetail)
			}
		})
	}
}

func TestUpdateProjectInputTracksExplicitNullProjectCode(t *testing.T) {
	var omitted UpdateProjectInput
	if err := json.Unmarshal([]byte(`{"name":"项目"}`), &omitted); err != nil {
		t.Fatal(err)
	}
	if omitted.HasField("project_code") {
		t.Fatal("omitted project_code is marked present")
	}

	var explicitNull UpdateProjectInput
	if err := json.Unmarshal([]byte(`{"name":"项目","project_code":null}`), &explicitNull); err != nil {
		t.Fatal(err)
	}
	if !explicitNull.HasField("project_code") || explicitNull.ProjectCode != nil {
		t.Fatalf("explicit null = %#v, want present nil project_code", explicitNull)
	}
}
