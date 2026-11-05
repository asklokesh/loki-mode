package status

import (
	"fmt"
	"io"
	"os"
)

// StatusCoder is an error that carries a process exit status.
type StatusCoder interface {
	error
	Status() int
}

// GroupError is an error made of several errors.
type GroupError interface {
	error
	Errors() []error
}

// Out receives the printed errors; exitFunc ends the process.
var Out io.Writer = os.Stderr
var exitFunc = os.Exit

type codeErr struct {
	msg  string
	code int
}

func (e codeErr) Error() string { return e.msg }
func (e codeErr) Status() int   { return e.code }

// NewCode returns an error that exits with code.
func NewCode(msg string, code int) error { return codeErr{msg, code} }

type groupErr struct{ errs []error }

func (g groupErr) Error() string   { return fmt.Sprintf("%d errors", len(g.errs)) }
func (g groupErr) Errors() []error { return g.errs }
func (g groupErr) Unwrap() []error { return g.errs }

// NewGroup returns a GroupError holding errs.
func NewGroup(errs ...error) error { return groupErr{errs} }

// Report prints err and exits with its status when it carries one.
func Report(err error) {
	if err == nil {
		return
	}
	if sc, ok := err.(StatusCoder); ok {
		fmt.Fprintln(Out, sc.Error())
		exitFunc(sc.Status())
		return
	}
	if ge, ok := err.(GroupError); ok {
		exitFunc(reportGroup(ge))
		return
	}
}

func reportGroup(ge GroupError) int {
	code := 1
	for _, e := range ge.Errors() {
		if sc, ok := e.(StatusCoder); ok {
			fmt.Fprintln(Out, sc.Error())
			code = sc.Status()
			continue
		}
		fmt.Fprintln(Out, e.Error())
	}
	return code
}
