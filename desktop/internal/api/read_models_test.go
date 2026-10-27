package api

import "testing"

func TestProjectDecoding(t *testing.T) {
	var projects []Project
	err := decodeOneJSON([]byte(`[{"id":1,"name":"北美站","is_active":true,"country":"US"}]`), &projects)
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) != 1 || projects[0].ID != 1 || projects[0].Name != "北美站" {
		t.Fatalf("projects = %+v", projects)
	}
}
