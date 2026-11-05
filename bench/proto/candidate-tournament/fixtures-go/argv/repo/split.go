package argv

import "strings"

// Parsed holds the flags and positional operands of one command line.
type Parsed struct {
	Flags []string
	Args  []string
}

// Split separates flags from operands. Operands keep their exact spelling.
func Split(rargs []string) Parsed {
	var p Parsed
	for ; len(rargs) > 0; rargs = rargs[1:] {
		firstArg := strings.TrimSpace(rargs[0])
		if firstArg == "" {
			p.Args = append(p.Args, rargs[0])
			continue
		}
		if firstArg[0] != '-' {
			p.Args = append(p.Args, rargs[0])
			continue
		}
		if firstArg == "--" {
			p.Args = append(p.Args, rargs[1:]...)
			return p
		}
		// this is same as firstArg == "-"
		if len(firstArg) == 1 {
			p.Args = append(p.Args, firstArg)
			break
		}
		p.Flags = append(p.Flags, firstArg)
	}
	return p
}
