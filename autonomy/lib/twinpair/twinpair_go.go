// Twin-site pair inputs, Go engine (PROTO; loki-ts/src/features/twin_pair.ts drives it). Standard library only:
// `go run twinpair_go.go <cmd> ...`. New file: nothing in the repo parses Go with go/ast (exec-spec's resolveSites is
// regex based and cannot compute method sets or rewrite one assertion).
//
// A chain is two or more type tests on one subject inside one function: `if v, ok := s.(T); ok`, `if errors.As(s, &v)`
// (v declared `var v T`), or the cases of `switch v := s.(type)`, in an else-if chain or in consecutive if-statements
// whose site bodies leave. The subject is a parameter (or `for _, s := range <param>`) that is never reassigned.
//
// gen writes ONE probe test file. For every candidate input it records, as JSON lines in $LOKI_TWIN_OUT, which site
// of the chain would take it and its observable outcome under the real function (twice), a faithful renamed copy, and
// renamed precedence variants: broaden a strict site to errors.As, narrow an errors.As site to a strict assertion,
// or swap two sites. Candidates come only from the package's own constructors and type declarations: an outer value
// of one site's type wrapping inner values of another site's type, and values of types that satisfy both.
// Which candidate is a pair input, and every verdict, is decided in twin_pair.ts. No model is involved.
//
//	gen     -pkg DIR -mode pre|post [-func F]... [-hunk FILE:a:b]... -out FILE -manifest FILE [-drop id,id]
//	observe -pkg DIR -cases FILE -out FILE -manifest FILE [-drop id,id]
//	scan    -root DIR
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/build"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type srcFile struct {
	name string
	src  []byte
	f    *ast.File
}

type pkg struct {
	dir     string
	name    string
	fset    *token.FileSet
	files   []*srcFile
	ifaces  map[string]map[string]bool // interface -> method names; nil map value = open (unknown)
	open    map[string]bool
	ptrM    map[string]map[string]bool // concrete type -> methods with any receiver
	valM    map[string]map[string]bool // concrete type -> value-receiver methods
	kind    map[string]ast.Expr        // type name -> underlying type expression
	funcs   []*ast.FuncDecl
	fileOf  map[ast.Node]*srcFile
	vars    []string
	hasDecl map[string]bool
}

type site struct {
	ID   string `json:"id"`
	Kind string `json:"kind"` // strict | deep | case
	Type string `json:"type"`
	Line int    `json:"line"`
	Src  string `json:"src"`

	types      []string // case clauses may list several
	assert     [2]int   // strict: the s.(T) span; deep: the errors.As call span
	target     string   // deep: the &v variable
	unit       [2]int   // the whole if-statement (plus its var decl) for sequential swaps
	branch     [2]int   // else-if branch span (init through body) or case clause span
	elifID     int      // >0 when the site is a branch of a multi-branch else-if chain
	listID     int      // statement list identity for sequential swaps
	isSwitch   bool
	switchID   int
	declTarget bool
}

type chain struct {
	Func    string  `json:"func"`
	Recv    string  `json:"recv,omitempty"`
	Subject string  `json:"subject"`
	SubjTyp string  `json:"subject_type"`
	Loop    string  `json:"loop,omitempty"`
	Sites   []*site `json:"sites"`
	Line    int     `json:"line"`
	Span    [2]int  `json:"span"`
	Skipped string  `json:"skipped,omitempty"`
	File    string  `json:"file"`

	fd   *ast.FuncDecl
	file *srcFile
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "twinpair_go:", err)
		os.Exit(2)
	}
}

func loadPkg(dir string) (*pkg, error) {
	ctx := build.Default
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	p := &pkg{dir: dir, fset: token.NewFileSet(), ifaces: map[string]map[string]bool{}, open: map[string]bool{}, ptrM: map[string]map[string]bool{}, valM: map[string]map[string]bool{}, kind: map[string]ast.Expr{}, fileOf: map[ast.Node]*srcFile{}, hasDecl: map[string]bool{}}
	for _, e := range ents {
		n := e.Name()
		if e.IsDir() || !strings.HasSuffix(n, ".go") || strings.HasSuffix(n, "_test.go") {
			continue
		}
		if ok, _ := ctx.MatchFile(dir, n); !ok {
			continue
		}
		src, err := os.ReadFile(filepath.Join(dir, n))
		if err != nil {
			return nil, err
		}
		f, err := parser.ParseFile(p.fset, filepath.Join(dir, n), src, parser.ParseComments)
		if err != nil {
			return nil, err
		}
		if p.name == "" {
			p.name = f.Name.Name
		}
		if f.Name.Name != p.name {
			continue
		}
		sf := &srcFile{name: n, src: src, f: f}
		p.files = append(p.files, sf)
	}
	if len(p.files) == 0 {
		return nil, fmt.Errorf("no buildable Go files in %s", dir)
	}
	for _, sf := range p.files {
		for _, d := range sf.f.Decls {
			switch d := d.(type) {
			case *ast.GenDecl:
				for _, sp := range d.Specs {
					switch sp := sp.(type) {
					case *ast.TypeSpec:
						p.hasDecl[sp.Name.Name] = true
						if sp.TypeParams != nil {
							continue
						}
						p.kind[sp.Name.Name] = sp.Type
					case *ast.ValueSpec:
						if d.Tok == token.VAR {
							for _, nm := range sp.Names {
								p.hasDecl[nm.Name] = true
								if nm.Name != "_" {
									p.vars = append(p.vars, nm.Name)
								}
							}
						}
					}
				}
			case *ast.FuncDecl:
				p.fileOf[d] = sf
				if d.Recv == nil {
					p.hasDecl[d.Name.Name] = true
					p.funcs = append(p.funcs, d)
					continue
				}
				tn, ptr := recvType(d)
				if tn == "" {
					continue
				}
				if p.ptrM[tn] == nil {
					p.ptrM[tn], p.valM[tn] = map[string]bool{}, map[string]bool{}
				}
				p.ptrM[tn][d.Name.Name] = true
				if !ptr {
					p.valM[tn][d.Name.Name] = true
				}
			}
		}
	}
	for name, t := range p.kind {
		if it, ok := t.(*ast.InterfaceType); ok {
			p.ifaceMethods(name, it, map[string]bool{})
		}
	}
	return p, nil
}

func recvType(d *ast.FuncDecl) (string, bool) {
	if d.Recv == nil || len(d.Recv.List) == 0 {
		return "", false
	}
	t := d.Recv.List[0].Type
	ptr := false
	if s, ok := t.(*ast.StarExpr); ok {
		ptr, t = true, s.X
	}
	if id, ok := t.(*ast.Ident); ok {
		return id.Name, ptr
	}
	return "", ptr
}

var knownIfaces = map[string][]string{"error": {"Error"}, "fmt.Stringer": {"String"}, "io.Writer": {"Write"}, "io.Reader": {"Read"}, "io.Closer": {"Close"}}

func (p *pkg) ifaceMethods(name string, it *ast.InterfaceType, seen map[string]bool) map[string]bool {
	if m, ok := p.ifaces[name]; ok {
		return m
	}
	if seen[name] {
		p.open[name] = true
		return map[string]bool{}
	}
	seen[name] = true
	m := map[string]bool{}
	for _, f := range it.Methods.List {
		if len(f.Names) > 0 {
			for _, n := range f.Names {
				m[n.Name] = true
			}
			continue
		}
		key := exprStr(f.Type)
		if ms, ok := knownIfaces[key]; ok {
			for _, x := range ms {
				m[x] = true
			}
			continue
		}
		if id, ok := f.Type.(*ast.Ident); ok {
			if sub, ok := p.kind[id.Name].(*ast.InterfaceType); ok {
				for x := range p.ifaceMethods(id.Name, sub, seen) {
					m[x] = true
				}
				if p.open[id.Name] {
					p.open[name] = true
				}
				continue
			}
		}
		p.open[name] = true // a type-set element or an embedded interface from another package
	}
	p.ifaces[name] = m
	return m
}

func exprStr(e ast.Expr) string {
	switch e := e.(type) {
	case *ast.Ident:
		return e.Name
	case *ast.SelectorExpr:
		return exprStr(e.X) + "." + e.Sel.Name
	case *ast.StarExpr:
		return "*" + exprStr(e.X)
	case *ast.ArrayType:
		if e.Len == nil {
			return "[]" + exprStr(e.Elt)
		}
		return "[" + exprStr(e.Len) + "]" + exprStr(e.Elt)
	case *ast.Ellipsis:
		return "..." + exprStr(e.Elt)
	case *ast.InterfaceType:
		if e.Methods == nil || len(e.Methods.List) == 0 {
			return "interface{}"
		}
		return "interface{...}"
	case *ast.MapType:
		return "map[" + exprStr(e.Key) + "]" + exprStr(e.Value)
	case *ast.BasicLit:
		return e.Value
	case *ast.FuncType:
		return "func(...)"
	case *ast.ChanType:
		return "chan " + exprStr(e.Value)
	case *ast.IndexExpr:
		return exprStr(e.X) + "[" + exprStr(e.Index) + "]"
	}
	return "?"
}

func (p *pkg) text(sf *srcFile, a, b token.Pos) string {
	return string(sf.src[p.fset.Position(a).Offset:p.fset.Position(b).Offset])
}

func (p *pkg) off(pos token.Pos) int { return p.fset.Position(pos).Offset }

// implements reports whether concrete type c (as *c when ptr) has every method of local interface i.
func (p *pkg) implements(c string, ptr bool, i string) bool {
	ms, ok := p.ifaces[i]
	if !ok || p.open[i] {
		return false
	}
	have := p.valM[c]
	if ptr {
		have = p.ptrM[c]
	}
	for m := range ms {
		if !have[m] {
			return false
		}
	}
	return true
}

func (p *pkg) isIface(t string) bool { _, ok := p.ifaces[t]; return ok }

// concrete types (name, needs pointer) whose values satisfy site type t.
func (p *pkg) satisfiers(t string) [][2]string {
	var out [][2]string
	if strings.HasPrefix(t, "*") {
		n := t[1:]
		if _, ok := p.kind[n]; ok && !p.isIface(n) {
			out = append(out, [2]string{n, "ptr"})
		}
		return out
	}
	if p.isIface(t) {
		names := make([]string, 0, len(p.kind))
		for n := range p.kind {
			names = append(names, n)
		}
		sort.Strings(names)
		for _, n := range names {
			if p.isIface(n) {
				continue
			}
			if p.implements(n, false, t) {
				out = append(out, [2]string{n, "val"})
			} else if p.implements(n, true, t) {
				out = append(out, [2]string{n, "ptr"})
			}
		}
		return out
	}
	if _, ok := p.kind[t]; ok {
		out = append(out, [2]string{t, "val"})
	}
	return out
}

func (p *pkg) hasMethod(c string, ptr bool, m string) bool {
	if ptr {
		return p.ptrM[c][m]
	}
	return p.valM[c][m]
}

// ---------------------------------------------------------------- chains

func leaves(b *ast.BlockStmt) bool {
	if b == nil || len(b.List) == 0 {
		return false
	}
	switch s := b.List[len(b.List)-1].(type) {
	case *ast.ReturnStmt, *ast.BranchStmt:
		return true
	case *ast.ExprStmt:
		if c, ok := s.X.(*ast.CallExpr); ok {
			if id, ok := c.Fun.(*ast.Ident); ok && id.Name == "panic" {
				return true
			}
		}
	}
	return false
}

type finder struct {
	p        *pkg
	sf       *srcFile
	fd       *ast.FuncDecl
	params   map[string]string // name -> type text
	loops    map[string]string // loop var -> param
	varDecls map[string]string // name -> declared type text (var v T anywhere in the function)
	out      []*chain
	nextID   int
}

func (fi *finder) errorsAs(e ast.Expr) (subj, target string, call *ast.CallExpr) {
	if b, ok := e.(*ast.BinaryExpr); ok && b.Op == token.LAND {
		e = b.X
	}
	c, ok := e.(*ast.CallExpr)
	if !ok || len(c.Args) != 2 {
		return
	}
	sel, ok := c.Fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "As" {
		return
	}
	pk, ok := sel.X.(*ast.Ident)
	if !ok || !fi.isErrorsPkg(pk.Name) {
		return
	}
	s, ok := c.Args[0].(*ast.Ident)
	if !ok {
		return
	}
	u, ok := c.Args[1].(*ast.UnaryExpr)
	if !ok || u.Op != token.AND {
		return
	}
	v, ok := u.X.(*ast.Ident)
	if !ok {
		return
	}
	return s.Name, v.Name, c
}

func (fi *finder) isErrorsPkg(name string) bool {
	for _, im := range fi.sf.f.Imports {
		path, _ := strconv.Unquote(im.Path.Value)
		local := filepath.Base(path)
		if im.Name != nil {
			local = im.Name.Name
		}
		if local == name && (path == "errors" || strings.HasSuffix(path, "/errors")) {
			return true
		}
	}
	return false
}

// siteOf classifies one if-branch: strict comma-ok assertion in the init, or errors.As in the condition.
func (fi *finder) siteOf(ifs *ast.IfStmt) (*site, string) {
	if as, ok := ifs.Init.(*ast.AssignStmt); ok && as.Tok == token.DEFINE && len(as.Lhs) == 2 && len(as.Rhs) == 1 {
		ta, ok := as.Rhs[0].(*ast.TypeAssertExpr)
		okName, ok2 := as.Lhs[1].(*ast.Ident)
		if ok && ok2 && ta.Type != nil {
			if s, ok := ta.X.(*ast.Ident); ok {
				c := ifs.Cond
				if b, ok := c.(*ast.BinaryExpr); ok && b.Op == token.LAND {
					c = b.X
				}
				if id, ok := c.(*ast.Ident); ok && id.Name == okName.Name {
					st := &site{Kind: "strict", Type: exprStr(ta.Type), types: []string{exprStr(ta.Type)}, Line: fi.p.fset.Position(ifs.Pos()).Line}
					st.assert = [2]int{fi.p.off(ta.Pos()), fi.p.off(ta.End())}
					st.Src = fi.p.text(fi.sf, ifs.Init.Pos(), ifs.Cond.End())
					return st, s.Name
				}
			}
		}
	}
	if s, target, call := fi.errorsAs(ifs.Cond); call != nil {
		t, ok := fi.varDecls[target]
		if !ok {
			return nil, ""
		}
		st := &site{Kind: "deep", Type: t, types: []string{t}, target: target, Line: fi.p.fset.Position(ifs.Pos()).Line}
		st.assert = [2]int{fi.p.off(call.Pos()), fi.p.off(call.End())}
		st.Src = fi.p.text(fi.sf, ifs.Cond.Pos(), ifs.Cond.End())
		return st, s
	}
	return nil, ""
}

func (fi *finder) walkList(list []ast.Stmt, listID int) {
	type entry struct {
		stmt  ast.Stmt
		sites []*site
		subj  []string
	}
	var run []entry
	flush := func() {
		by := map[string][]*site{}
		order := []string{}
		for _, e := range run {
			for k, s := range e.sites {
				subj := e.subj[k]
				if _, ok := by[subj]; !ok {
					order = append(order, subj)
				}
				by[subj] = append(by[subj], s)
			}
		}
		for _, subj := range order {
			if len(by[subj]) >= 2 {
				fi.addChain(subj, by[subj])
			}
		}
		run = nil
	}
	var pendingDecl ast.Stmt
	for _, st := range list {
		switch s := st.(type) {
		case *ast.DeclStmt:
			pendingDecl = s
			fi.recurse(st)
			continue
		case *ast.IfStmt:
			var e entry
			e.stmt = s
			branches := []*ast.IfStmt{s}
			for n := s; ; {
				el, ok := n.Else.(*ast.IfStmt)
				if !ok {
					break
				}
				branches = append(branches, el)
				n = el
			}
			fi.nextID++
			elif := 0
			if len(branches) > 1 {
				elif = fi.nextID
			}
			allLeave := true
			for _, b := range branches {
				ss, subj := fi.siteOf(b)
				if ss == nil {
					continue
				}
				ss.elifID, ss.listID = elif, listID
				ss.branch = [2]int{fi.p.off(initOrCond(b)), fi.p.off(b.Body.End())}
				start := s.Pos()
				if pendingDecl != nil && ss.Kind == "deep" {
					start = pendingDecl.Pos()
					ss.declTarget = true
				}
				ss.unit = [2]int{fi.p.off(start), fi.p.off(s.End())}
				e.sites = append(e.sites, ss)
				e.subj = append(e.subj, subj)
				if !leaves(b.Body) {
					allLeave = false
				}
			}
			pendingDecl = nil
			run = append(run, e)
			if !allLeave {
				flush()
			}
			fi.recurse(st)
			continue
		case *ast.TypeSwitchStmt:
			flush()
			fi.typeSwitch(s)
			fi.recurse(st)
			pendingDecl = nil
			continue
		}
		pendingDecl = nil
		flush()
		fi.recurse(st)
	}
	flush()
}

func initOrCond(b *ast.IfStmt) token.Pos {
	if b.Init != nil {
		return b.Init.Pos()
	}
	return b.Cond.Pos()
}

func (fi *finder) typeSwitch(s *ast.TypeSwitchStmt) {
	var x ast.Expr
	switch a := s.Assign.(type) {
	case *ast.AssignStmt:
		if len(a.Rhs) == 1 {
			x = a.Rhs[0]
		}
	case *ast.ExprStmt:
		x = a.X
	}
	ta, ok := x.(*ast.TypeAssertExpr)
	if !ok {
		return
	}
	subj, ok := ta.X.(*ast.Ident)
	if !ok {
		return
	}
	fi.nextID++
	var sites []*site
	for _, c := range s.Body.List {
		cc := c.(*ast.CaseClause)
		if cc.List == nil {
			continue
		}
		var types []string
		for _, t := range cc.List {
			if id, ok := t.(*ast.Ident); ok && id.Name == "nil" {
				continue
			}
			types = append(types, exprStr(t))
		}
		if len(types) == 0 {
			continue
		}
		st := &site{Kind: "case", Type: strings.Join(types, ", "), types: types, Line: fi.p.fset.Position(cc.Pos()).Line, Src: "case " + strings.Join(types, ", "), isSwitch: true, switchID: fi.nextID}
		st.branch = [2]int{fi.p.off(cc.Pos()), fi.p.off(cc.End())}
		sites = append(sites, st)
	}
	if len(sites) >= 2 {
		fi.addChain(subj.Name, sites)
	}
}

func (fi *finder) recurse(st ast.Stmt) {
	switch s := st.(type) {
	case *ast.BlockStmt:
		fi.walkList(s.List, fi.newList())
	case *ast.IfStmt:
		fi.walkList(s.Body.List, fi.newList())
		switch el := s.Else.(type) {
		case *ast.BlockStmt:
			fi.walkList(el.List, fi.newList())
		case *ast.IfStmt:
			// branches of an else-if chain are walked as part of the chain; recurse into their bodies only
			for n := el; n != nil; {
				fi.walkList(n.Body.List, fi.newList())
				switch e2 := n.Else.(type) {
				case *ast.IfStmt:
					n = e2
				case *ast.BlockStmt:
					fi.walkList(e2.List, fi.newList())
					n = nil
				default:
					n = nil
				}
			}
		}
	case *ast.ForStmt:
		fi.walkList(s.Body.List, fi.newList())
	case *ast.RangeStmt:
		if v, ok := s.Value.(*ast.Ident); ok && s.Tok == token.DEFINE {
			if x, ok := s.X.(*ast.Ident); ok {
				if _, isParam := fi.params[x.Name]; isParam {
					fi.loops[v.Name] = x.Name
				}
			}
		}
		fi.walkList(s.Body.List, fi.newList())
	case *ast.SwitchStmt:
		for _, c := range s.Body.List {
			fi.walkList(c.(*ast.CaseClause).Body, fi.newList())
		}
	case *ast.TypeSwitchStmt:
		for _, c := range s.Body.List {
			fi.walkList(c.(*ast.CaseClause).Body, fi.newList())
		}
	case *ast.SelectStmt:
		for _, c := range s.Body.List {
			fi.walkList(c.(*ast.CommClause).Body, fi.newList())
		}
	case *ast.LabeledStmt:
		fi.recurse(s.Stmt)
	}
}

func (fi *finder) newList() int { fi.nextID++; return fi.nextID }

func (fi *finder) addChain(subj string, sites []*site) {
	for k, s := range sites {
		s.ID = fmt.Sprintf("s%d", k+1)
	}
	c := &chain{Func: fi.fd.Name.Name, Subject: subj, Sites: sites, fd: fi.fd, file: fi.sf, File: fi.sf.name, Line: fi.p.fset.Position(fi.fd.Pos()).Line}
	c.Span = [2]int{c.Line, fi.p.fset.Position(fi.fd.End()).Line}
	if tn, ptr := recvType(fi.fd); tn != "" {
		c.Recv = tn
		if ptr {
			c.Recv = "*" + tn
		}
	} else if fi.fd.Recv != nil {
		c.Skipped = "generic receiver"
	}
	if t, ok := fi.params[subj]; ok {
		c.SubjTyp = t
	} else if lp, ok := fi.loops[subj]; ok {
		c.Loop = lp
		c.SubjTyp = strings.TrimPrefix(fi.params[lp], "[]")
		if !strings.HasPrefix(fi.params[lp], "[]") {
			c.Skipped = "loop over a non-slice"
		}
	} else {
		c.Skipped = "subject not an argument"
	}
	if c.Skipped == "" && fi.fd.Type.TypeParams != nil {
		c.Skipped = "generic function"
	}
	if c.Skipped == "" && reassigned(fi.fd, subj, c.Loop != "") {
		c.Skipped = "subject reassigned"
	}
	if c.Skipped == "" && strings.HasPrefix(fi.params[subj], "...") {
		c.Skipped = "variadic subject"
	}
	fi.out = append(fi.out, c)
}

func reassigned(fd *ast.FuncDecl, name string, loop bool) bool {
	n := 0
	ast.Inspect(fd.Body, func(x ast.Node) bool {
		switch s := x.(type) {
		case *ast.AssignStmt:
			for _, l := range s.Lhs {
				if id, ok := l.(*ast.Ident); ok && id.Name == name {
					n++
				}
			}
		case *ast.RangeStmt:
			if id, ok := s.Value.(*ast.Ident); ok && id.Name == name {
				if !loop {
					n++
				}
			}
			if id, ok := s.Key.(*ast.Ident); ok && id.Name == name {
				n++
			}
		case *ast.UnaryExpr:
			if s.Op == token.AND {
				if id, ok := s.X.(*ast.Ident); ok && id.Name == name {
					n++
				}
			}
		}
		return true
	})
	return n > 0
}

func (p *pkg) chains(filter func(*ast.FuncDecl, *srcFile) bool) []*chain {
	var out []*chain
	for _, sf := range p.files {
		for _, d := range sf.f.Decls {
			fd, ok := d.(*ast.FuncDecl)
			if !ok || fd.Body == nil || (filter != nil && !filter(fd, sf)) {
				continue
			}
			fi := &finder{p: p, sf: sf, fd: fd, params: map[string]string{}, loops: map[string]string{}, varDecls: map[string]string{}}
			for _, f := range fd.Type.Params.List {
				for _, n := range f.Names {
					fi.params[n.Name] = exprStr(f.Type)
				}
			}
			ast.Inspect(fd.Body, func(x ast.Node) bool {
				if vs, ok := x.(*ast.ValueSpec); ok && vs.Type != nil {
					for _, n := range vs.Names {
						fi.varDecls[n.Name] = exprStr(vs.Type)
					}
				}
				return true
			})
			fi.walkList(fd.Body.List, fi.newList())
			// a chain's deep sites must test the chain subject; drop sites that test another name
			for _, c := range fi.out {
				out = append(out, c)
			}
		}
	}
	return out
}

// ---------------------------------------------------------------- candidates

type cand struct {
	ID   string `json:"id"`
	Src  string `json:"src"`
	Note string `json:"note"`
}

type filler struct {
	p      *pkg
	seed   int
	usedCx bool
	depth  int
}

var ints = map[string]bool{"int": true, "int8": true, "int16": true, "int32": true, "int64": true, "uint": true, "uint8": true, "uint16": true, "uint32": true, "uint64": true, "uintptr": true, "byte": true, "rune": true}

// value returns a Go expression of type t, or "" when none can be written without new imports.
func (fl *filler) value(t string, errs []string) string {
	sv := []string{"a", "b", "c", "d"}[fl.seed%4]
	iv := []string{"3", "5", "7", "9"}[fl.seed%4]
	switch {
	case t == "error":
		if len(errs) > 0 {
			return errs[0]
		}
		return fmt.Sprintf("lkerrors.New(%q)", "loki-twin-plain-"+sv)
	case t == "[]error":
		if len(errs) > 0 {
			return "[]error{" + strings.Join(errs, ", ") + "}"
		}
		return "nil"
	case t == "string":
		return strconv.Quote("loki-twin-" + sv)
	case ints[t]:
		return iv
	case t == "float32" || t == "float64":
		return iv + ".5"
	case t == "bool":
		return "true"
	case t == "any" || t == "interface{}":
		return strconv.Quote("loki-twin-" + sv)
	case t == "[]string":
		return "[]string{" + strconv.Quote("loki-twin-"+sv) + "}"
	case t == "[]byte":
		return "[]byte(" + strconv.Quote("loki-twin-"+sv) + ")"
	case t == "context.Context":
		fl.usedCx = true
		return "lkcontext.TODO()"
	case t == "time.Duration":
		return iv
	case strings.HasPrefix(t, "*") || strings.HasPrefix(t, "[]") || strings.HasPrefix(t, "map[") || strings.HasPrefix(t, "func(") || strings.HasPrefix(t, "chan "):
		if strings.Contains(t, ".") {
			return "nil"
		}
		return "nil"
	}
	if u, ok := fl.p.kind[t]; ok {
		if fl.p.isIface(t) {
			return "nil"
		}
		switch ut := u.(type) {
		case *ast.Ident:
			if inner := fl.value(ut.Name, nil); inner != "" && ut.Name != "error" {
				return t + "(" + inner + ")"
			}
		case *ast.StructType:
			// scalar fields get this seed's values, so two nested payloads (an outer and an inner one) differ
			if fl.depth > 0 {
				return t + "{}"
			}
			fl.depth++
			var fs []string
			for _, f := range ut.Fields.List {
				ft := exprStr(f.Type)
				for _, n := range fieldNames(f) {
					if v := fl.value(ft, nil); v != "" && v != "nil" && !strings.HasPrefix(v, "*new(") && !strings.HasSuffix(v, "{}") {
						fs = append(fs, n+": "+v)
					}
				}
			}
			fl.depth--
			return t + "{" + strings.Join(fs, ", ") + "}"
		}
		return "*new(" + t + ")"
	}
	return ""
}

// templates of constructing expressions for concrete type c; "@E" marks one error slot, "@ES" a list slot.
func (p *pkg) templates(c string, ptr bool) []string {
	var out []string
	want := map[string]bool{c: true, "*" + c: true}
	for _, fd := range p.funcs {
		if fd.Type.TypeParams != nil || fd.Type.Results == nil || len(fd.Type.Results.List) != 1 || len(fd.Type.Results.List[0].Names) > 1 {
			continue
		}
		rt := exprStr(fd.Type.Results.List[0].Type)
		ok := want[rt]
		if !ok && p.isIface(rt) && mentions(fd, c) {
			ok = true
		}
		if !ok {
			continue
		}
		out = append(out, fd.Name.Name+"(@ARGS)")
		if len(out) >= 3 {
			break
		}
	}
	amp := ""
	if ptr {
		amp = "&"
	}
	switch u := p.kind[c].(type) {
	case *ast.StructType:
		out = append(out, amp+c+"{@FIELDS}")
	case *ast.ArrayType:
		if u.Len == nil && exprStr(u.Elt) == "error" {
			out = append(out, amp+c+"{@ES}")
		}
	case *ast.Ident:
		if ptr {
			out = append(out, "func() *"+c+" { v := "+c+"(@BASIC); return &v }()")
		} else {
			out = append(out, c+"(@BASIC)")
		}
	}
	return out
}

// fieldNames lists a struct field's names; an embedded field is named by its type (T for T, *T and pkg.T).
func fieldNames(f *ast.Field) []string {
	if len(f.Names) > 0 {
		var out []string
		for _, n := range f.Names {
			out = append(out, n.Name)
		}
		return out
	}
	t := strings.TrimPrefix(exprStr(f.Type), "*")
	if i := strings.LastIndex(t, "."); i >= 0 {
		t = t[i+1:]
	}
	return []string{t}
}

func mentions(fd *ast.FuncDecl, c string) bool {
	found := false
	ast.Inspect(fd.Body, func(x ast.Node) bool {
		switch e := x.(type) {
		case *ast.CompositeLit:
			if id, ok := e.Type.(*ast.Ident); ok && id.Name == c {
				found = true
			}
		case *ast.CallExpr:
			if id, ok := e.Fun.(*ast.Ident); ok && (id.Name == c || (id.Name == "new" && len(e.Args) == 1 && exprStr(e.Args[0]) == c)) {
				found = true
			}
		}
		return !found
	})
	return found
}

func (p *pkg) funcByName(n string) *ast.FuncDecl {
	for _, fd := range p.funcs {
		if fd.Name.Name == n {
			return fd
		}
	}
	return nil
}

// instantiate fills a template; errs fill the error slots (one slot takes errs[0], a list slot takes all).
func (p *pkg) instantiate(tpl, c string, errs []string, seed int, fl *filler) string {
	fl.seed = seed
	switch {
	case strings.Contains(tpl, "@ARGS"):
		fd := p.funcByName(tpl[:strings.Index(tpl, "(")])
		var args []string
		for _, f := range fd.Type.Params.List {
			t := exprStr(f.Type)
			names := len(f.Names)
			if names == 0 {
				names = 1
			}
			for k := 0; k < names; k++ {
				if strings.HasPrefix(t, "...") {
					et := t[3:]
					if et == "error" {
						args = append(args, errs...)
						continue
					}
					continue
				}
				v := fl.value(t, errs)
				if v == "" {
					return ""
				}
				args = append(args, v)
			}
		}
		return strings.Replace(tpl, "@ARGS", strings.Join(args, ", "), 1)
	case strings.Contains(tpl, "@FIELDS"):
		st := p.kind[c].(*ast.StructType)
		var fs []string
		for _, f := range st.Fields.List {
			t := exprStr(f.Type)
			for _, n := range fieldNames(f) {
				if t == "error" || t == "[]error" {
					if len(errs) > 0 {
						fs = append(fs, n+": "+fl.value(t, errs))
					}
					continue
				}
				v := fl.value(t, nil)
				if v != "" && v != "nil" && !strings.HasPrefix(v, "*new(") {
					fs = append(fs, n+": "+v)
				}
			}
		}
		return strings.Replace(tpl, "@FIELDS", strings.Join(fs, ", "), 1)
	case strings.Contains(tpl, "@ES"):
		return strings.Replace(tpl, "@ES", strings.Join(errs, ", "), 1)
	case strings.Contains(tpl, "@BASIC"):
		u := exprStr(p.kind[c])
		v := fl.value(u, nil)
		if v == "" {
			return ""
		}
		return strings.Replace(tpl, "@BASIC", v, 1)
	}
	return tpl
}

func hasErrSlot(p *pkg, tpl, c string) bool {
	switch {
	case strings.Contains(tpl, "@ES"):
		return true
	case strings.Contains(tpl, "@ARGS"):
		fd := p.funcByName(tpl[:strings.Index(tpl, "(")])
		for _, f := range fd.Type.Params.List {
			t := exprStr(f.Type)
			if t == "error" || t == "[]error" || t == "...error" {
				return true
			}
		}
	case strings.Contains(tpl, "@FIELDS"):
		for _, f := range p.kind[c].(*ast.StructType).Fields.List {
			t := exprStr(f.Type)
			if t == "error" || t == "[]error" {
				return true
			}
		}
	}
	return false
}

// candidates for one chain: for every ordered pair of sites, outer values of the later site's type that wrap inner
// values of the earlier site's type (unwrapping is what makes an errors.As site reach them), and values of types that
// satisfy both sites; plus one plain value per site type so every site is reachable on its own.
func (p *pkg) candidates(c *chain) []cand {
	var out []cand
	seen := map[string]bool{}
	add := func(src, note string) {
		if src == "" || seen[src] || len(out) >= 24 {
			return
		}
		seen[src] = true
		out = append(out, cand{ID: fmt.Sprintf("c%d", len(out)+1), Src: src, Note: note})
	}
	fl := &filler{p: p}
	plain := func(t string, seed int) []string {
		var vals []string
		for _, s := range p.satisfiers(t) {
			for _, tpl := range p.templates(s[0], s[1] == "ptr") {
				if v := p.instantiate(tpl, s[0], nil, seed, fl); v != "" {
					vals = append(vals, v)
				}
			}
		}
		return vals
	}
	for _, si := range c.Sites {
		for _, ti := range si.types {
			if vs := plain(ti, 0); len(vs) > 0 {
				add(vs[0], "plain "+ti)
			}
		}
	}
	for i, si := range c.Sites {
		for j, sj := range c.Sites {
			if i == j {
				continue
			}
			for _, ti := range si.types {
				for _, tj := range sj.types {
					inner1, inner2 := plain(ti, 0), plain(ti, 1)
					if len(inner1) == 0 {
						continue
					}
					plainErr := "lkerrors.New(\"loki-twin-plain\")"
					for _, s := range p.satisfiers(tj) {
						ptr := s[1] == "ptr"
						if !p.hasMethod(s[0], ptr, "Unwrap") {
							continue
						}
						for _, tpl := range p.templates(s[0], ptr) {
							if !hasErrSlot(p, tpl, s[0]) {
								continue
							}
							in2 := inner1[0]
							if len(inner2) > 0 {
								in2 = inner2[0]
							}
							add(p.instantiate(tpl, s[0], []string{inner1[0], in2}, 2, fl), fmt.Sprintf("%s wrapping two %s", tj, ti))
							add(p.instantiate(tpl, s[0], []string{plainErr, inner1[0]}, 2, fl), fmt.Sprintf("%s wrapping a plain error and a %s", tj, ti))
						}
					}
					for _, s := range p.satisfiers(tj) {
						if p.isIface(ti) && p.implements(s[0], s[1] == "ptr", ti) {
							for _, tpl := range p.templates(s[0], s[1] == "ptr") {
								add(p.instantiate(tpl, s[0], nil, 0, fl), fmt.Sprintf("satisfies both %s and %s", ti, tj))
							}
						}
					}
				}
			}
		}
	}
	return out
}

// ---------------------------------------------------------------- variants and the probe file

type variant struct {
	ID    string   `json:"id"`
	Kind  string   `json:"kind"`
	Site  string   `json:"site"`
	Site2 string   `json:"site2,omitempty"`
	Order []string `json:"order"`
	name  string
	code  string
}

func (p *pkg) funcCopy(c *chain, newName string, edits [][3]string) string {
	sf := c.file
	start, end := p.off(c.fd.Pos()), p.off(c.fd.End())
	nameA, nameB := p.off(c.fd.Name.Pos())-start, p.off(c.fd.Name.End())-start
	body := string(sf.src[start:end])
	type ed struct {
		a, b int
		s    string
	}
	eds := []ed{{nameA, nameB, newName}}
	for _, e := range edits {
		a, _ := strconv.Atoi(e[0])
		b, _ := strconv.Atoi(e[1])
		eds = append(eds, ed{a - start, b - start, e[2]})
	}
	sort.Slice(eds, func(i, j int) bool { return eds[i].a > eds[j].a })
	for _, e := range eds {
		body = body[:e.a] + e.s + body[e.b:]
	}
	return body
}

func (p *pkg) slice(sf *srcFile, a, b int) string { return string(sf.src[a:b]) }

func ids(sites []*site) []string {
	var o []string
	for _, s := range sites {
		o = append(o, s.ID)
	}
	return o
}

func (p *pkg) variants(c *chain, mode, key string) []variant {
	var out []variant
	base := ids(c.Sites)
	n := 0
	mk := func(kind, s1, s2 string, order []string, edits [][3]string, helper string) {
		n++
		name := fmt.Sprintf("lokiTwin%sV%d_%s", key, n, c.Func)
		id := fmt.Sprintf("%s_%s%s", kind, s1, map[bool]string{true: "_" + s2, false: ""}[s2 != ""])
		if kind == "identity" {
			id = "identity"
		}
		out = append(out, variant{ID: id, Kind: kind, Site: s1, Site2: s2, Order: order, name: name, code: helper + p.funcCopy(c, name, edits)})
	}
	// a renamed copy with no edit: observations that differ between it and the real function come from copying, not precedence
	mk("identity", "", "", base, nil, "")
	errSubj := c.SubjTyp == "error"
	for k, s := range c.Sites {
		switch {
		case s.Kind == "strict" && errSubj && mode == "pre":
			h := fmt.Sprintf("func lokiTwin%sAs%d(e error) (%s, bool) {\n\tvar t %s\n\tok := lkerrors.As(e, &t)\n\treturn t, ok\n}\n\n", key, k, s.Type, s.Type)
			mk("broaden", s.ID, "", base, [][3]string{{strconv.Itoa(s.assert[0]), strconv.Itoa(s.assert[1]), fmt.Sprintf("lokiTwin%sAs%d(%s)", key, k, c.Subject)}}, h)
		case s.Kind == "deep" && mode == "post":
			h := fmt.Sprintf("func lokiTwin%sStrict%d(e error, p *%s) bool {\n\tt, ok := e.(%s)\n\tif ok {\n\t\t*p = t\n\t}\n\treturn ok\n}\n\n", key, k, s.Type, s.Type)
			mk("narrow", s.ID, "", base, [][3]string{{strconv.Itoa(s.assert[0]), strconv.Itoa(s.assert[1]), fmt.Sprintf("lokiTwin%sStrict%d(%s, &%s)", key, k, c.Subject, s.target)}}, h)
		}
	}
	for i := 0; i < len(c.Sites); i++ {
		for j := i + 1; j < len(c.Sites); j++ {
			a, b := c.Sites[i], c.Sites[j]
			var sa, sb [2]int
			switch {
			case a.isSwitch && b.isSwitch && a.switchID == b.switchID:
				sa, sb = a.branch, b.branch
			case a.elifID > 0 && a.elifID == b.elifID:
				sa, sb = a.branch, b.branch
			case a.elifID == 0 && b.elifID == 0 && !a.isSwitch && !b.isSwitch && a.listID == b.listID && a.unit != b.unit:
				sa, sb = a.unit, b.unit
			default:
				continue
			}
			order := append([]string{}, base...)
			order[i], order[j] = order[j], order[i]
			ta, tb := p.slice(c.file, sa[0], sa[1]), p.slice(c.file, sb[0], sb[1])
			mk("swap", a.ID, b.ID, order, [][3]string{{strconv.Itoa(sa[0]), strconv.Itoa(sa[1]), tb}, {strconv.Itoa(sb[0]), strconv.Itoa(sb[1]), ta}}, "")
		}
	}
	return out
}

func usedImports(c *chain) []string {
	used := map[string]bool{}
	ast.Inspect(c.fd, func(x ast.Node) bool {
		if s, ok := x.(*ast.SelectorExpr); ok {
			if id, ok := s.X.(*ast.Ident); ok {
				used[id.Name] = true
			}
		}
		return true
	})
	var out []string
	for _, im := range c.file.f.Imports {
		path, _ := strconv.Unquote(im.Path.Value)
		local := filepath.Base(path)
		if im.Name != nil {
			local = im.Name.Name
		}
		if local == "_" || local == "." {
			continue
		}
		if used[local] || (im.Name == nil && used[guessName(path)]) {
			spec := im.Path.Value
			if im.Name != nil {
				spec = im.Name.Name + " " + spec
			}
			out = append(out, spec)
		}
	}
	return out
}

func guessName(path string) string {
	b := filepath.Base(path)
	if strings.HasPrefix(b, "v") && len(b) > 1 && strings.Trim(b[1:], "0123456789") == "" {
		b = filepath.Base(filepath.Dir(path))
	}
	if i := strings.Index(b, ".v"); i > 0 && strings.Trim(b[i+2:], "0123456789") == "" {
		b = b[:i]
	}
	b = strings.TrimPrefix(b, "go-")
	b = strings.TrimSuffix(b, "-go")
	b = strings.TrimSuffix(b, ".go")
	return strings.ReplaceAll(b, "-", "")
}

func (p *pkg) callExpr(c *chain, fn string, x string) (string, int, bool) {
	var args []string
	for _, f := range c.fd.Type.Params.List {
		t := exprStr(f.Type)
		names := f.Names
		if len(names) == 0 {
			names = []*ast.Ident{{Name: "_"}}
		}
		for _, nm := range names {
			switch {
			case nm.Name == c.Subject:
				args = append(args, x)
			case c.Loop != "" && nm.Name == c.Loop:
				args = append(args, "[]"+c.SubjTyp+"{"+x+"}")
			case strings.HasPrefix(t, "..."):
			default:
				fl := &filler{p: p}
				v := fl.value(t, nil)
				if v == "" {
					return "", 0, false
				}
				args = append(args, v)
			}
		}
	}
	nres := 0
	if c.fd.Type.Results != nil {
		for _, r := range c.fd.Type.Results.List {
			if len(r.Names) == 0 {
				nres++
			} else {
				nres += len(r.Names)
			}
		}
	}
	call := fn + "(" + strings.Join(args, ", ") + ")"
	if c.Recv != "" {
		rt := strings.TrimPrefix(c.Recv, "*")
		var recv string
		if _, isStruct := p.kind[rt].(*ast.StructType); isStruct {
			recv = rt + "{}"
			if strings.HasPrefix(c.Recv, "*") {
				recv = "&" + recv
			}
		} else if strings.HasPrefix(c.Recv, "*") {
			recv = "new(" + rt + ")"
		} else {
			recv = "*new(" + rt + ")"
		}
		call = "(" + recv + ")." + call
	}
	return call, nres, true
}

const probeHelpers = `
type lokiTwinRec struct {
	Cand    string            ` + "`json:\"cand\"`" + `
	Variant string            ` + "`json:\"variant\"`" + `
	Obs     map[string]string ` + "`json:\"obs,omitempty\"`" + `
	Preds   map[string]bool   ` + "`json:\"preds,omitempty\"`" + `
}

var lokiTwinMu lksync.Mutex
var lokiTwinAddr = lkregexp.MustCompile("0x[0-9a-f]{6,}")

func lokiTwinEmit(r lokiTwinRec) {
	lokiTwinMu.Lock()
	defer lokiTwinMu.Unlock()
	f, err := lkos.OpenFile(lkos.Getenv("LOKI_TWIN_OUT"), lkos.O_APPEND|lkos.O_CREATE|lkos.O_WRONLY, 0600)
	if err != nil {
		return
	}
	defer f.Close()
	b, _ := lkjson.Marshal(r)
	f.Write(append(b, '\n'))
}

func lokiTwinNorm(s string) string { return lokiTwinAddr.ReplaceAllString(s, "0xADDR") }

func lokiTwinPipe(target **lkos.File) func() string {
	r, w, err := lkos.Pipe()
	if err != nil {
		return func() string { return "" }
	}
	old := *target
	*target = w
	done := make(chan string, 1)
	go func() {
		var b lkbytes.Buffer
		lkio.Copy(&b, r)
		done <- b.String()
	}()
	return func() string {
		w.Close()
		*target = old
		return <-done
	}
}

func lokiTwinObserve(call func() []interface{}) map[string]string {
	obs := map[string]string{}
	writerT := lkreflect.TypeOf((*lkio.Writer)(nil)).Elem()
	bufT := lkreflect.TypeOf(&lkbytes.Buffer{})
	var restore []func()
	bufs := map[string]*lkbytes.Buffer{}
	var calls []string
	for _, v := range lokiTwinVars {
		rv := lkreflect.ValueOf(v.ptr).Elem()
		if !rv.CanSet() {
			continue
		}
		name := v.name
		switch {
		case rv.Kind() == lkreflect.Func && rv.Type().NumOut() == 0:
			old := lkreflect.New(rv.Type()).Elem()
			old.Set(rv)
			rv.Set(lkreflect.MakeFunc(rv.Type(), func(args []lkreflect.Value) []lkreflect.Value {
				var parts []string
				for _, a := range args {
					parts = append(parts, lkfmt.Sprintf("%v", a.Interface()))
				}
				lokiTwinMu.Lock()
				calls = append(calls, name+"("+lkstrings.Join(parts, ",")+")")
				lokiTwinMu.Unlock()
				return nil
			}))
			restore = append(restore, func() { rv.Set(old) })
		case rv.Kind() == lkreflect.Interface && rv.Type().Implements(writerT) && bufT.AssignableTo(rv.Type()):
			old := lkreflect.New(rv.Type()).Elem()
			old.Set(rv)
			b := &lkbytes.Buffer{}
			rv.Set(lkreflect.ValueOf(b))
			bufs[name] = b
			restore = append(restore, func() { rv.Set(old) })
		}
	}
	stopOut, stopErr := lokiTwinPipe(&lkos.Stdout), lokiTwinPipe(&lkos.Stderr)
	func() {
		defer func() {
			if r := recover(); r != nil {
				obs["panic"] = lokiTwinNorm(lkfmt.Sprint(r))
			}
		}()
		for i, r := range call() {
			obs[lkfmt.Sprintf("ret%d", i)] = lokiTwinNorm(lkfmt.Sprintf("%T:%+v", r, r))
		}
	}()
	obs["stdout"], obs["stderr"] = lokiTwinNorm(stopOut()), lokiTwinNorm(stopErr())
	for i := len(restore) - 1; i >= 0; i-- {
		restore[i]()
	}
	obs["calls"] = lokiTwinNorm(lkstrings.Join(calls, ";"))
	for k, b := range bufs {
		obs["w:"+k] = lokiTwinNorm(b.String())
	}
	return obs
}
`

type manifest struct {
	Lang    string              `json:"lang"`
	Pkg     string              `json:"pkg"`
	Mode    string              `json:"mode"`
	Chains  []*chainOut         `json:"chains"`
	Lines   map[string][2]int   `json:"lines"` // generated-file line range per candidate or variant key
	Dropped []string            `json:"dropped,omitempty"`
	Vars    []string            `json:"vars"`
	Census  map[string]int      `json:"census,omitempty"`
	Imports []string            `json:"imports,omitempty"`
	Extra   map[string][]string `json:"extra,omitempty"`
}

type chainOut struct {
	*chain
	Key        string    `json:"key"`
	Variants   []variant `json:"variants"`
	Candidates []cand    `json:"candidates"`
	Order      []string  `json:"order"`
}

func (p *pkg) predExpr(s *site, xv string, deep bool) string {
	var parts []string
	for _, t := range s.types {
		if deep {
			parts = append(parts, fmt.Sprintf("func() bool { var t %s; return lkerrors.As(%s, &t) }()", t, xv))
		} else {
			parts = append(parts, fmt.Sprintf("func() bool { _, ok := interface{}(%s).(%s); return ok }()", xv, t))
		}
	}
	return strings.Join(parts, " || ")
}

type caseIn struct {
	Key    string `json:"key"`
	Func   string `json:"func"`
	Recv   string `json:"recv"`
	Subj   string `json:"subject"`
	Src    string `json:"src"`
	ChainK string `json:"chain"`
}

// writeProbe renders the probe file; variant and candidate blocks carry line ranges so build errors can drop them.
func (p *pkg) writeProbe(outFile string, cos []*chainOut, cases []caseIn, observeOnly bool, drop map[string]bool) (map[string][2]int, []string) {
	var b strings.Builder
	lines := map[string][2]int{}
	line := func() int { return strings.Count(b.String(), "\n") + 1 }
	imports := map[string]bool{}
	for _, co := range cos {
		if observeOnly {
			break // no function copies are written, so the function's own imports would be unused
		}
		for _, im := range usedImports(co.chain) {
			imports[im] = true
		}
	}
	b.WriteString("// Code generated by the Loki twin-site pair probe. Removed after the run.\n\npackage " + p.name + "\n\nimport (\n")
	for _, im := range []string{`lkbytes "bytes"`, `lkcontext "context"`, `lkjson "encoding/json"`, `lkerrors "errors"`, `lkfmt "fmt"`, `lkio "io"`, `lkos "os"`, `lkreflect "reflect"`, `lkregexp "regexp"`, `lkstrings "strings"`, `lksync "sync"`, `lktesting "testing"`} {
		b.WriteString("\t" + im + "\n")
	}
	var ims []string
	for im := range imports {
		ims = append(ims, im)
	}
	sort.Strings(ims)
	for _, im := range ims {
		b.WriteString("\t" + im + "\n")
	}
	b.WriteString(")\n\nvar _ = lkcontext.TODO\nvar _ = lkerrors.New\n")
	b.WriteString(probeHelpers)
	b.WriteString("\nvar lokiTwinVars = []struct {\n\tname string\n\tptr  interface{}\n}{\n")
	for _, v := range p.vars {
		b.WriteString(fmt.Sprintf("\t{%q, &%s},\n", v, v))
	}
	b.WriteString("}\n\n")
	var dropped []string
	var body strings.Builder
	body.WriteString("func TestLokiTwinProbe(t *lktesting.T) {\n")
	for _, co := range cos {
		if !observeOnly {
			for _, v := range co.Variants {
				key := co.Key + "/" + v.ID
				if drop[key] {
					dropped = append(dropped, key)
					continue
				}
				a := line()
				b.WriteString("\n" + v.code + "\n")
				lines[key] = [2]int{a, line()}
			}
		}
		for _, cd := range co.Candidates {
			key := co.Key + "/" + cd.ID
			if observeOnly {
				key = cd.ID
			}
			if drop[key] {
				dropped = append(dropped, key)
				continue
			}
			fnName := fmt.Sprintf("lokiTwinCase_%s_%s", strings.ReplaceAll(co.Key, "-", "_"), cd.ID)
			a := line()
			b.WriteString(fmt.Sprintf("\nfunc %s() {\n\tmk := func() %s { return %s }\n\t_ = mk\n", fnName, co.SubjTyp, cd.Src))
			preds := []string{}
			for _, s := range co.Sites {
				preds = append(preds, fmt.Sprintf("%q: %s", s.ID, p.predExpr(s, "mk()", s.Kind == "deep")))
			}
			if !observeOnly && co.SubjTyp == "error" {
				for _, v := range co.Variants {
					if drop[co.Key+"/"+v.ID] {
						continue
					}
					for _, s := range co.Sites {
						if s.ID != v.Site {
							continue
						}
						if v.Kind == "broaden" {
							preds = append(preds, fmt.Sprintf("%q: %s", "v:"+v.ID, p.predExpr(s, "mk()", true)))
						} else if v.Kind == "narrow" {
							preds = append(preds, fmt.Sprintf("%q: %s", "v:"+v.ID, p.predExpr(s, "mk()", false)))
						}
					}
				}
			}
			b.WriteString(fmt.Sprintf("\tlokiTwinEmit(lokiTwinRec{Cand: %q, Variant: \"preds\", Preds: map[string]bool{%s}})\n", key, strings.Join(preds, ", ")))
			calls := [][2]string{{"real", co.Func}, {"real2", co.Func}}
			if !observeOnly {
				for _, v := range co.Variants {
					if !drop[co.Key+"/"+v.ID] {
						calls = append(calls, [2]string{v.ID, v.name})
					}
				}
			}
			for _, cl := range calls {
				ce, nres, ok := p.callExpr(co.chain, cl[1], "mk()")
				if !ok {
					continue
				}
				rets := "nil"
				stmt := "\t\t" + ce + "\n"
				if nres > 0 {
					var rs []string
					for k := 0; k < nres; k++ {
						rs = append(rs, fmt.Sprintf("r%d", k))
					}
					stmt = "\t\t" + strings.Join(rs, ", ") + " := " + ce + "\n"
					rets = "[]interface{}{" + strings.Join(rs, ", ") + "}"
				}
				b.WriteString(fmt.Sprintf("\tlokiTwinEmit(lokiTwinRec{Cand: %q, Variant: %q, Obs: lokiTwinObserve(func() []interface{} {\n%s\t\treturn %s\n\t})})\n", key, cl[0], stmt, rets))
			}
			b.WriteString("}\n")
			lines[key] = [2]int{a, line()}
			body.WriteString("\t" + fnName + "()\n")
		}
	}
	body.WriteString("}\n")
	b.WriteString("\n" + body.String())
	must(os.WriteFile(outFile, []byte(b.String()), 0o644))
	return lines, dropped
}

func parseHunks(hs []string) map[string][][2]int {
	out := map[string][][2]int{}
	for _, h := range hs {
		parts := strings.Split(h, ":")
		if len(parts) != 3 {
			continue
		}
		a, _ := strconv.Atoi(parts[1])
		b, _ := strconv.Atoi(parts[2])
		out[parts[0]] = append(out[parts[0]], [2]int{a, b})
	}
	return out
}

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(s string) error { *m = append(*m, s); return nil }

func main() {
	if len(os.Args) < 2 {
		must(fmt.Errorf("usage: gen|observe|scan"))
	}
	cmd := os.Args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	dir := fs.String("pkg", "", "package directory")
	root := fs.String("root", "", "repository root (scan)")
	mode := fs.String("mode", "pre", "pre|post")
	out := fs.String("out", "", "probe file to write")
	man := fs.String("manifest", "", "manifest JSON to write")
	casesF := fs.String("cases", "", "cases JSON (observe)")
	dropF := fs.String("drop", "", "comma-separated keys to leave out")
	var funcs, hunks multi
	fs.Var(&funcs, "func", "function name filter")
	fs.Var(&hunks, "hunk", "FILE:a:b changed line range")
	must(fs.Parse(os.Args[2:]))
	drop := map[string]bool{}
	for _, d := range strings.Split(*dropF, ",") {
		if d != "" {
			drop[d] = true
		}
	}
	switch cmd {
	case "scan":
		scan(*root)
		return
	case "gen", "observe":
	default:
		must(fmt.Errorf("unknown command %s", cmd))
	}
	p, err := loadPkg(*dir)
	must(err)
	hk := parseHunks(hunks)
	fset := map[string]bool{}
	for _, f := range funcs {
		fset[f] = true
	}
	var cases []caseIn
	if cmd == "observe" {
		raw, err := os.ReadFile(*casesF)
		must(err)
		must(json.Unmarshal(raw, &cases))
		for _, c := range cases {
			fset[c.Func] = true
		}
	}
	filter := func(fd *ast.FuncDecl, sf *srcFile) bool {
		if len(fset) > 0 && !fset[fd.Name.Name] {
			return false
		}
		if len(hk) == 0 {
			return true
		}
		a, b := p.fset.Position(fd.Pos()).Line, p.fset.Position(fd.End()).Line
		for _, h := range hk[sf.name] {
			if h[0] <= b && a <= h[1] {
				return true
			}
		}
		return false
	}
	m := manifest{Lang: "go", Pkg: p.name, Mode: *mode, Vars: p.vars}
	var cos []*chainOut
	for k, c := range p.chains(filter) {
		co := &chainOut{chain: c, Key: fmt.Sprintf("k%d", k+1), Order: ids(c.Sites)}
		if c.Skipped == "" {
			if cmd == "gen" {
				co.Variants = p.variants(c, *mode, fmt.Sprintf("K%d", k+1))
				co.Candidates = p.candidates(c)
			} else {
				for _, cs := range cases {
					if cs.Func == c.Func && cs.Recv == c.Recv && cs.Subj == c.Subject {
						co.Candidates = append(co.Candidates, cand{ID: cs.Key, Src: cs.Src})
					}
				}
			}
		}
		m.Chains = append(m.Chains, co)
		if c.Skipped == "" && len(co.Candidates) > 0 {
			cos = append(cos, co)
		}
	}
	if cmd == "observe" {
		// functions whose chain vanished on this tree are still observed through a chain-less entry
		have := map[string]bool{}
		for _, co := range cos {
			for _, cd := range co.Candidates {
				have[cd.ID] = true
			}
		}
		for _, cs := range cases {
			if have[cs.Key] {
				continue
			}
			for _, fd := range p.funcs {
				if fd.Name.Name == cs.Func && cs.Recv == "" {
					c := &chain{Func: cs.Func, Subject: cs.Subj, fd: fd, file: p.fileOf[fd]}
					for _, f := range fd.Type.Params.List {
						for _, n := range f.Names {
							if n.Name == cs.Subj {
								c.SubjTyp = exprStr(f.Type)
							}
						}
					}
					if c.SubjTyp != "" {
						cos = append(cos, &chainOut{chain: c, Key: "orphan_" + cs.Key, Candidates: []cand{{ID: cs.Key, Src: cs.Src}}})
					}
				}
			}
		}
	}
	if len(cos) > 0 && *out != "" {
		m.Lines, m.Dropped = p.writeProbe(*out, cos, cases, cmd == "observe", drop)
	}
	if *man != "" {
		b, _ := json.MarshalIndent(m, "", " ")
		must(os.WriteFile(*man, b, 0o644))
	}
}

func scan(root string) {
	census := map[string]int{}
	var hits []map[string]any
	filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			n := d.Name()
			if path != root && (strings.HasPrefix(n, ".") || n == "vendor" || n == "testdata" || n == "node_modules") {
				return filepath.SkipDir
			}
			p, err := loadPkg(path)
			if err != nil {
				return nil
			}
			census["packages"]++
			census["functions"] += len(p.funcs)
			for _, c := range p.chains(nil) {
				census["chains"]++
				if c.Skipped != "" {
					census["skip:"+c.Skipped]++
					continue
				}
				census["eligible"]++
				kinds := map[string]bool{}
				for _, s := range c.Sites {
					kinds[s.Kind] = true
				}
				for k := range kinds {
					census["eligible_with_"+k]++
				}
				cs := p.candidates(c)
				if len(cs) > 0 {
					census["with_candidates"]++
				}
				pairs := 0
				for _, cd := range cs {
					if strings.Contains(cd.Note, "wrapping") || strings.Contains(cd.Note, "satisfies both") {
						pairs++
					}
				}
				if pairs > 0 {
					census["with_pair_candidates"]++
				}
				rel, _ := filepath.Rel(root, path)
				hits = append(hits, map[string]any{"pkg": rel, "func": c.Func, "recv": c.Recv, "line": c.Line, "sites": len(c.Sites), "candidates": len(cs), "pair_candidates": pairs})
			}
		}
		return nil
	})
	b, _ := json.Marshal(map[string]any{"lang": "go", "census": census, "eligible": hits})
	fmt.Println(string(b))
}
