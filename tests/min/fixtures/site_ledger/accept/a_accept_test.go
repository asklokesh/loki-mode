package status

import (
	"errors"
	"fmt"
	"testing"
)

func TestAcceptWrappedCoder(t *testing.T) {
	buf, code := capture(t)
	Report(fmt.Errorf("ctx: %w", NewCode("boom", 3)))
	if *code != 3 || buf.String() != "boom\n" {
		t.Fatalf("wrapped coder: code %d out %q", *code, buf.String())
	}
}

func TestAcceptGroupWithWrappedCoder(t *testing.T) {
	buf, code := capture(t)
	Report(NewGroup(errors.New("plain"), fmt.Errorf("w: %w", NewCode("inner", 4))))
	if *code != 4 || buf.String() != "plain\ninner\n" {
		t.Fatalf("group with wrapped coder: code %d out %q", *code, buf.String())
	}
}

func TestAcceptWrappedGroup(t *testing.T) {
	buf, code := capture(t)
	Report(fmt.Errorf("outer: %w", NewGroup(errors.New("one"), NewCode("two", 5))))
	if *code != 5 || buf.String() != "one\ntwo\n" {
		t.Fatalf("wrapped group: code %d out %q", *code, buf.String())
	}
}
