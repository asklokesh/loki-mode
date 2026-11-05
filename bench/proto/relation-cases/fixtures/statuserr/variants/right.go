package statuserr

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// StatusCoder is an error that carries a process status code.
type StatusCoder interface {
	error
	Status() int
}

type statusError struct {
	msg  string
	code int
	err  error
}

// Status returns an error carrying code. The underlying error stays reachable through Unwrap.
func Status(msg string, code int) StatusCoder { return &statusError{msg: msg, code: code} }

func (e *statusError) Error() string  { return e.msg }
func (e *statusError) Status() int    { return e.code }
func (e *statusError) Unwrap() error  { return e.err }

// Batch is an error that holds several errors.
type Batch interface {
	error
	Errors() []error
}

type batch []error

// NewBatch groups errs into one Batch.
func NewBatch(errs ...error) Batch { return batch(errs) }

func (b batch) Error() string {
	parts := make([]string, 0, len(b))
	for _, e := range b {
		parts = append(parts, e.Error())
	}
	return strings.Join(parts, "\n")
}
func (b batch) Errors() []error { return b }

// Exiter is called with the final status. Tests replace it.
var Exiter = func(code int) { os.Exit(code) }

// ErrWriter receives the reported message.
var ErrWriter io.Writer = os.Stderr

// Report writes err to ErrWriter and calls Exiter with its status when err is a StatusCoder or a Batch.
func Report(err error) {
	if err == nil {
		return
	}
	var sc StatusCoder
	if errors.As(err, &sc) {
		if msg := err.Error(); msg != "" {
			fmt.Fprintln(ErrWriter, msg)
		}
		Exiter(sc.Status())
		return
	}
	var b Batch
	if errors.As(err, &b) {
		Exiter(reportBatch(b))
		return
	}
}

func reportBatch(b Batch) int {
	code := 1
	for _, e := range b.Errors() {
		fmt.Fprintln(ErrWriter, e.Error())
		var sc StatusCoder
		if errors.As(e, &sc) {
			code = sc.Status()
		}
	}
	return code
}
