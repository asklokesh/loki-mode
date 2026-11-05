package statuserr

// PRIVATE ORACLE: scored only after the pick, never shown to any prompt. It checks only what the issue decides:
// the exit status of a wrapped StatusCoder, of a Batch holding a wrapped StatusCoder, and of a wrapped Batch (the
// issue says Report finds a Batch with a bare assertion too), and that something is reported. Message text is not
// pinned, because the issue does not say which message a wrapped error prints.

import (
	"bytes"
	"errors"
	"fmt"
	"testing"
)

func oracleCapture(t *testing.T) (*bytes.Buffer, *int) {
	t.Helper()
	buf, code := &bytes.Buffer{}, -1
	oldW, oldE := ErrWriter, Exiter
	ErrWriter, Exiter = buf, func(c int) { code = c }
	t.Cleanup(func() { ErrWriter, Exiter = oldW, oldE })
	return buf, &code
}

func TestOracle_WrappedStatus(t *testing.T) {
	buf, code := oracleCapture(t)
	Report(fmt.Errorf("sync failed: %w", Status("disk quota exceeded", 9)))
	if *code != 9 || buf.Len() == 0 {
		t.Fatalf("code=%d out=%q", *code, buf.String())
	}
}

func TestOracle_BatchWithWrappedStatus(t *testing.T) {
	_, code := oracleCapture(t)
	Report(NewBatch(errors.New("first"), fmt.Errorf("ctx: %w", Status("late", 11))))
	if *code != 11 {
		t.Fatalf("code=%d", *code)
	}
}

func TestOracle_WrappedBatch(t *testing.T) {
	_, code := oracleCapture(t)
	Report(fmt.Errorf("ctx: %w", NewBatch(errors.New("a"), Status("b", 6))))
	if *code != 6 {
		t.Fatalf("code=%d", *code)
	}
}
