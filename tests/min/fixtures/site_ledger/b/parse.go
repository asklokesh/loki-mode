package argv

import "strings"

// Parser splits command-line arguments into flags and positional arguments.
type Parser struct {
	Flags map[string]string
	Pos   []string
}

// Parse fills p from args. Flags and positionals may be mixed; "--" ends flag parsing.
func (p *Parser) Parse(args []string) {
	if p.Flags == nil {
		p.Flags = map[string]string{}
	}
	rargs := args
	for len(rargs) > 0 {
		firstArg := strings.TrimSpace(rargs[0])
		if firstArg == "--" {
			p.Pos = append(p.Pos, rargs[1:]...)
			break
		}
		if firstArg == "-" {
			// a lone dash usually means stdin
			p.Pos = append(p.Pos, firstArg)
			break
		}
		if strings.HasPrefix(firstArg, "-") {
			name, val, _ := strings.Cut(strings.TrimLeft(firstArg, "-"), "=")
			p.Flags[name] = val
			rargs = rargs[1:]
			continue
		}
		p.Pos = append(p.Pos, rargs[0])
		rargs = rargs[1:]
	}
}
