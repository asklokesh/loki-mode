package tests

// Repo conventions every exported function in package mathx must follow.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"strings"
	"testing"

	"example.com/mathx/mathx"
)

func exportedFuncs(t *testing.T) map[string]*ast.FuncDecl {
	t.Helper()
	files, err := filepath.Glob(filepath.Join("..", "mathx", "*.go"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no mathx sources: %v", err)
	}
	out := map[string]*ast.FuncDecl{}
	fset := token.NewFileSet()
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, f, nil, parser.ParseComments)
		if err != nil {
			t.Fatalf("parse %s: %v", f, err)
		}
		for _, d := range file.Decls {
			if fn, ok := d.(*ast.FuncDecl); ok && fn.Recv == nil && fn.Name.IsExported() {
				out[fn.Name.Name] = fn
			}
		}
	}
	return out
}

func TestEveryExportedFuncIsRegistered(t *testing.T) {
	for name := range exportedFuncs(t) {
		if _, ok := mathx.Funcs[name]; !ok {
			t.Errorf("register %s in mathx/registry.go Funcs (\"%s\": %s)", name, name, name)
		}
	}
	for name := range mathx.Funcs {
		if _, ok := exportedFuncs(t)[name]; !ok {
			t.Errorf("mathx.Funcs names %s, which is not an exported func", name)
		}
	}
}

func TestEveryExportedFuncHasADocComment(t *testing.T) {
	for name, fn := range exportedFuncs(t) {
		if fn.Doc == nil || !strings.HasPrefix(fn.Doc.Text(), name+" ") {
			t.Errorf("give %s a doc comment that starts with %q", name, name+" ")
		}
	}
}
