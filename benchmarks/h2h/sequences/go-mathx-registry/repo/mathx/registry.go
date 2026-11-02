package mathx

// Funcs lists every exported helper by name; the app's expression evaluator looks helpers up here.
var Funcs = map[string]any{
	"Abs":   Abs,
	"Clamp": Clamp,
}
