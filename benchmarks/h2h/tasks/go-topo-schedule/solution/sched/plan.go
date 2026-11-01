package sched

import (
	"container/heap"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// UnknownDepError reports a dependency that is not itself a task.
type UnknownDepError struct {
	Task string
	Dep  string
}

func (e *UnknownDepError) Error() string {
	return fmt.Sprintf("task %q depends on unknown task %q", e.Task, e.Dep)
}

// CycleError reports a dependency cycle. Path starts and ends with the same task.
type CycleError struct {
	Path []string
}

func (e *CycleError) Error() string {
	return "dependency cycle: " + strings.Join(e.Path, " -> ")
}

// graph is the task map with tasks numbered in ascending name order, so
// comparing ids compares names.
type graph struct {
	names []string
	deps  [][]int // sorted, unique
}

func buildGraph(tasks map[string][]string) (*graph, error) {
	names := make([]string, 0, len(tasks))
	for t := range tasks {
		names = append(names, t)
	}
	sort.Strings(names)
	id := make(map[string]int, len(names))
	for i, n := range names {
		id[n] = i
	}
	for _, n := range names {
		missing := ""
		for _, d := range tasks[n] {
			if _, ok := id[d]; !ok && (missing == "" || d < missing) {
				missing = d
			}
		}
		if missing != "" {
			return nil, &UnknownDepError{Task: n, Dep: missing}
		}
	}
	deps := make([][]int, len(names))
	for i, n := range names {
		list := make([]int, 0, len(tasks[n]))
		for _, d := range tasks[n] {
			list = append(list, id[d])
		}
		sort.Ints(list)
		uniq := list[:0]
		for j, v := range list {
			if j == 0 || v != list[j-1] {
				uniq = append(uniq, v)
			}
		}
		deps[i] = uniq
	}
	return &graph{names: names, deps: deps}, nil
}

// dependents returns the reverse adjacency lists.
func (g *graph) dependents() [][]int {
	out := make([][]int, len(g.names))
	for i, ds := range g.deps {
		for _, d := range ds {
			out[d] = append(out[d], i)
		}
	}
	return out
}

// topo returns a topological order (dependencies first) and each task's
// batch level, or ok=false when the graph has a cycle.
func (g *graph) topo() (order, level []int, ok bool) {
	n := len(g.names)
	rev := g.dependents()
	pending := make([]int, n)
	level = make([]int, n)
	order = make([]int, 0, n)
	for i := range g.deps {
		pending[i] = len(g.deps[i])
		if pending[i] == 0 {
			order = append(order, i)
		}
	}
	for head := 0; head < len(order); head++ {
		x := order[head]
		for _, y := range rev[x] {
			if level[x]+1 > level[y] {
				level[y] = level[x] + 1
			}
			pending[y]--
			if pending[y] == 0 {
				order = append(order, y)
			}
		}
	}
	return order, level, len(order) == n
}

// Plan groups tasks into batches: batch k holds every task whose dependencies
// are all in earlier batches. Each batch is sorted ascending.
func Plan(tasks map[string][]string) ([][]string, error) {
	g, err := buildGraph(tasks)
	if err != nil {
		return nil, err
	}
	_, level, ok := g.topo()
	if !ok {
		return nil, &CycleError{Path: g.canonicalCycle()}
	}
	batches := [][]string{}
	for i, name := range g.names { // ascending ids keep each batch sorted
		for len(batches) <= level[i] {
			batches = append(batches, []string{})
		}
		batches[level[i]] = append(batches[level[i]], name)
	}
	return batches, nil
}

// sccs labels strongly connected components (iterative Tarjan).
func (g *graph) sccs() (comp, size []int) {
	n := len(g.names)
	index := make([]int, n)
	low := make([]int, n)
	onStack := make([]bool, n)
	comp = make([]int, n)
	for i := range index {
		index[i] = -1
	}
	var stack []int
	type frame struct{ v, next int }
	counter := 0
	for root := 0; root < n; root++ {
		if index[root] >= 0 {
			continue
		}
		call := []frame{{root, 0}}
		index[root], low[root] = counter, counter
		counter++
		stack = append(stack, root)
		onStack[root] = true
		for len(call) > 0 {
			f := &call[len(call)-1]
			v := f.v
			if f.next < len(g.deps[v]) {
				w := g.deps[v][f.next]
				f.next++
				if index[w] < 0 {
					index[w], low[w] = counter, counter
					counter++
					stack = append(stack, w)
					onStack[w] = true
					call = append(call, frame{w, 0})
				} else if onStack[w] && index[w] < low[v] {
					low[v] = index[w]
				}
				continue
			}
			if low[v] == index[v] {
				c := len(size)
				size = append(size, 0)
				for {
					w := stack[len(stack)-1]
					stack = stack[:len(stack)-1]
					onStack[w] = false
					comp[w] = c
					size[c]++
					if w == v {
						break
					}
				}
			}
			call = call[:len(call)-1]
			if len(call) > 0 {
				p := call[len(call)-1].v
				if low[v] < low[p] {
					low[p] = low[v]
				}
			}
		}
	}
	return comp, size
}

// canonicalCycle picks the smallest task on any cycle and walks back to it,
// always taking the smallest dependency that can still close the cycle
// without revisiting a task already on the path. A witness path back to start
// is kept so that most steps need no search; a failed search proves every
// task it visited can never reach start again, so those are marked dead.
func (g *graph) canonicalCycle() []string {
	comp, size := g.sccs()
	start := -1
	for i := range g.names {
		if size[comp[i]] > 1 {
			start = i
			break
		}
		if j := sort.SearchInts(g.deps[i], i); j < len(g.deps[i]) && g.deps[i][j] == i {
			start = i
			break
		}
	}
	n := len(g.names)
	sc := comp[start]
	onPath := make([]bool, n)
	dead := make([]bool, n)
	seen := make([]int, n)
	parent := make([]int, n)
	stamp := 0
	type frame struct{ v, next int }

	// search returns a simple path v, ..., start avoiding the current path.
	search := func(v int) []int {
		stamp++
		seen[v] = stamp
		parent[v] = -1
		visited := []int{v}
		call := []frame{{v, 0}}
		for len(call) > 0 {
			f := &call[len(call)-1]
			x := f.v
			if f.next >= len(g.deps[x]) {
				call = call[:len(call)-1]
				continue
			}
			w := g.deps[x][f.next]
			f.next++
			if w == start {
				var rev []int
				for y := x; y >= 0; y = parent[y] {
					rev = append(rev, y)
				}
				out := make([]int, 0, len(rev)+1)
				for i := len(rev) - 1; i >= 0; i-- {
					out = append(out, rev[i])
				}
				return append(out, start)
			}
			if comp[w] != sc || onPath[w] || dead[w] || seen[w] == stamp {
				continue
			}
			seen[w] = stamp
			parent[w] = x
			visited = append(visited, w)
			call = append(call, frame{w, 0})
		}
		for _, y := range visited {
			dead[y] = true
		}
		return nil
	}

	path := []int{start}
	onPath[start] = true
	var witness []int
	wi := 0
	u := start
	for {
		next := -1
		for _, v := range g.deps[u] {
			if v == start {
				next = v
				break
			}
			if comp[v] != sc || onPath[v] || dead[v] {
				continue
			}
			if wi < len(witness) && witness[wi] == v {
				next = v
				wi++
				break
			}
			if p := search(v); p != nil {
				witness, wi = p, 1
				next = v
				break
			}
		}
		path = append(path, next)
		if next == start {
			break
		}
		onPath[next] = true
		u = next
	}
	out := make([]string, len(path))
	for i, v := range path {
		out[i] = g.names[v]
	}
	return out
}

// Task is one unit of work for Simulate.
type Task struct {
	Deps     []string
	Duration int
	Priority int
}

// Slot is when and where a task ran.
type Slot struct {
	Start  int
	End    int
	Worker int
}

// Schedule is the result of Simulate.
type Schedule struct {
	Slots        map[string]Slot
	Makespan     int
	CriticalPath []string
}

// ErrNoWorkers is returned by Simulate when workers < 1.
var ErrNoWorkers = errors.New("sched: at least one worker is required")

// InvalidDurationError reports a task whose Duration is not positive.
type InvalidDurationError struct {
	Task string
}

func (e *InvalidDurationError) Error() string {
	return fmt.Sprintf("task %q has a non-positive duration", e.Task)
}

type intHeap struct {
	items []int
	less  func(a, b int) bool
}

func (h *intHeap) Len() int           { return len(h.items) }
func (h *intHeap) Less(i, j int) bool { return h.less(h.items[i], h.items[j]) }
func (h *intHeap) Swap(i, j int)      { h.items[i], h.items[j] = h.items[j], h.items[i] }
func (h *intHeap) Push(x any)         { h.items = append(h.items, x.(int)) }
func (h *intHeap) Pop() any {
	x := h.items[len(h.items)-1]
	h.items = h.items[:len(h.items)-1]
	return x
}

// Simulate runs tasks on workers with a non-preemptive list scheduler.
func Simulate(tasks map[string]Task, workers int) (Schedule, error) {
	if workers < 1 {
		return Schedule{}, ErrNoWorkers
	}
	bad := ""
	depMap := make(map[string][]string, len(tasks))
	for name, t := range tasks {
		if t.Duration <= 0 && (bad == "" || name < bad) {
			bad = name
		}
		depMap[name] = t.Deps
	}
	if bad != "" {
		return Schedule{}, &InvalidDurationError{Task: bad}
	}
	g, err := buildGraph(depMap)
	if err != nil {
		return Schedule{}, err
	}
	order, _, ok := g.topo()
	if !ok {
		return Schedule{}, &CycleError{Path: g.canonicalCycle()}
	}

	n := len(g.names)
	dur := make([]int, n)
	pri := make([]int, n)
	for i, name := range g.names {
		dur[i] = tasks[name].Duration
		pri[i] = tasks[name].Priority
	}
	start := make([]int, n)
	end := make([]int, n)
	worker := make([]int, n)
	rev := g.dependents()
	pending := make([]int, n)

	ready := &intHeap{less: func(a, b int) bool {
		if pri[a] != pri[b] {
			return pri[a] > pri[b]
		}
		if dur[a] != dur[b] {
			return dur[a] > dur[b]
		}
		return a < b
	}}
	running := &intHeap{less: func(a, b int) bool { return end[a] < end[b] }}
	free := &intHeap{less: func(a, b int) bool { return a < b }}
	fresh := 0 // workers numbered >= fresh have never been used

	for i := range g.deps {
		pending[i] = len(g.deps[i])
		if pending[i] == 0 {
			ready.items = append(ready.items, i)
		}
	}
	heap.Init(ready)
	t := 0
	for {
		for running.Len() > 0 && end[running.items[0]] == t {
			x := heap.Pop(running).(int)
			heap.Push(free, worker[x])
			for _, y := range rev[x] {
				pending[y]--
				if pending[y] == 0 {
					heap.Push(ready, y)
				}
			}
		}
		for ready.Len() > 0 && (free.Len() > 0 || fresh < workers) {
			x := heap.Pop(ready).(int)
			if free.Len() > 0 {
				worker[x] = heap.Pop(free).(int)
			} else {
				worker[x] = fresh
				fresh++
			}
			start[x], end[x] = t, t+dur[x]
			heap.Push(running, x)
		}
		if running.Len() == 0 {
			break
		}
		t = end[running.items[0]]
	}

	slots := make(map[string]Slot, n)
	makespan := 0
	for i, name := range g.names {
		slots[name] = Slot{Start: start[i], End: end[i], Worker: worker[i]}
		if end[i] > makespan {
			makespan = end[i]
		}
	}

	weight := make([]int, n)
	for _, x := range order {
		best := 0
		for _, d := range g.deps[x] {
			if weight[d] > best {
				best = weight[d]
			}
		}
		weight[x] = best + dur[x]
	}
	cur := -1
	for i := 0; i < n; i++ { // ascending ids, so ties keep the smallest name
		if end[i] == makespan && (cur < 0 || weight[i] > weight[cur]) {
			cur = i
		}
	}
	path := []string{}
	for cur >= 0 {
		path = append(path, g.names[cur])
		next := -1
		for _, d := range g.deps[cur] {
			if next < 0 || weight[d] > weight[next] {
				next = d
			}
		}
		cur = next
	}
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return Schedule{Slots: slots, Makespan: makespan, CriticalPath: path}, nil
}
