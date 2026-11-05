package statuserr

import (
	"bytes"
	"errors"
	"testing"
)

func capture(t *testing.T) (*bytes.Buffer, *int) {
	t.Helper()
	buf, code := &bytes.Buffer{}, -1
	oldW, oldE := ErrWriter, Exiter
	ErrWriter, Exiter = buf, func(c int) { code = c }
	t.Cleanup(func() { ErrWriter, Exiter = oldW, oldE })
	return buf, &code
}

func TestReport_Status(t *testing.T) {
	buf, code := capture(t)
	Report(Status("boom", 4))
	if *code != 4 || buf.String() != "boom\n" {
		t.Fatalf("code=%d out=%q", *code, buf.String())
	}
}

func TestReport_Batch(t *testing.T) {
	_, code := capture(t)
	Report(NewBatch(errors.New("a"), Status("b", 6)))
	if *code != 6 {
		t.Fatalf("code=%d", *code)
	}
}
