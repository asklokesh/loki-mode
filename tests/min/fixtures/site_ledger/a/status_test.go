package status

import (
	"bytes"
	"testing"
)

func capture(t *testing.T) (*bytes.Buffer, *int) {
	t.Helper()
	var buf bytes.Buffer
	code := -1
	Out, exitFunc = &buf, func(c int) { code = c }
	return &buf, &code
}

func TestReportDirect(t *testing.T) {
	buf, code := capture(t)
	Report(NewCode("boom", 3))
	if *code != 3 || buf.String() != "boom\n" {
		t.Fatalf("got code %d out %q", *code, buf.String())
	}
}
