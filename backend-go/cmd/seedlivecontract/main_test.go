package main

import "testing"

func TestValidateDatabaseName(t *testing.T) {
	cases := []struct {
		url     string
		wantErr bool
	}{
		{"postgresql+psycopg://ci:ci@localhost:5432/blf_ci", false},
		{"postgresql://localhost/BLF_test", false},
		{"postgresql://localhost/BLF_test?sslmode=disable", false},
		{"postgresql://localhost/BLF", true},
		{"postgresql://localhost/blf_test_archive", true},
		{"", true},
	}
	for _, testCase := range cases {
		err := validateDatabaseName(testCase.url)
		if (err != nil) != testCase.wantErr {
			t.Errorf("validateDatabaseName(%q) error=%v, wantErr=%v", testCase.url, err, testCase.wantErr)
		}
	}
}
