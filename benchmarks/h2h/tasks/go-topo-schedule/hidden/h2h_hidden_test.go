package tests

import (
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"testing"
	"time"

	"example.com/sched/sched"
)

const scaleLimit = 2 * time.Second

func timed(t *testing.T, label string, fn func()) {
	t.Helper()
	began := time.Now()
	fn()
	if took := time.Since(began); took > scaleLimit {
		t.Fatalf("%s took %v, limit %v", label, took, scaleLimit)
	} else {
		t.Logf("%s took %v", label, took)
	}
}

func toTasks(deps map[string][]string) map[string]sched.Task {
	out := make(map[string]sched.Task, len(deps))
	for k, v := range deps {
		out[k] = sched.Task{Deps: v, Duration: 1}
	}
	return out
}

func expectCycleAtScale(t *testing.T, label string, deps map[string][]string, want []string) {
	t.Helper()
	var err error
	timed(t, label+" Plan", func() { _, err = sched.Plan(deps) })
	var ce *sched.CycleError
	if !errors.As(err, &ce) {
		t.Fatalf("%s Plan err = %v, want *CycleError", label, err)
	}
	if !reflect.DeepEqual(ce.Path, want) {
		t.Fatalf("%s Plan cycle Path has %d entries, want %d (first %v)", label, len(ce.Path), len(want), want[:3])
	}
	tasks := toTasks(deps)
	timed(t, label+" Simulate", func() { _, err = sched.Simulate(tasks, 4) })
	ce = nil
	if !errors.As(err, &ce) || !reflect.DeepEqual(ce.Path, want) {
		t.Fatalf("%s Simulate err = %v, want the same *CycleError as Plan", label, err)
	}
}

func TestHiddenScaleRandomDAG(t *testing.T) {
	const n = 200000
	rng := rand.New(rand.NewSource(42))
	perm := rng.Perm(n)
	names := make([]string, n)
	for i := range names {
		names[i] = fmt.Sprintf("t%06d", perm[i]) // name order differs from dependency order
	}
	idx := make(map[string]int, n)
	for i, s := range names {
		idx[s] = i
	}
	depIdx := make([][]int, n)
	deps := make(map[string][]string, n)
	tasks := make(map[string]sched.Task, n)
	for i := 0; i < n; i++ {
		var ds []int
		if i > 0 && rng.Intn(2) == 0 {
			ds = append(ds, i-1) // long chains
		}
		if i > 0 {
			for k := rng.Intn(5 - len(ds) + 1); k > 0; k-- {
				ds = append(ds, rng.Intn(i))
			}
		}
		depIdx[i] = ds
		list := make([]string, len(ds))
		for j, d := range ds {
			list[j] = names[d]
		}
		deps[names[i]] = list
		tasks[names[i]] = sched.Task{Deps: list, Duration: 1 + rng.Intn(20), Priority: rng.Intn(5)}
	}

	var batches [][]string
	var err error
	timed(t, "Plan on 200000 tasks", func() { batches, err = sched.Plan(deps) })
	if err != nil {
		t.Fatal(err)
	}
	level := make([]int, n)
	for i := range level {
		level[i] = -1
	}
	for b, batch := range batches {
		if len(batch) == 0 || !sort.StringsAreSorted(batch) {
			t.Fatalf("batch %d is empty or not sorted", b)
		}
		for _, s := range batch {
			i, ok := idx[s]
			if !ok || level[i] >= 0 {
				t.Fatalf("task %q unknown or placed twice", s)
			}
			level[i] = b
		}
	}
	for i := 0; i < n; i++ {
		want := 0
		for _, d := range depIdx[i] {
			if level[d]+1 > want {
				want = level[d] + 1
			}
		}
		if level[i] != want {
			t.Fatalf("task %q is in batch %d, want %d", names[i], level[i], want)
		}
	}

	var s sched.Schedule
	timed(t, "Simulate on 200000 tasks with 8 workers", func() { s, err = sched.Simulate(tasks, 8) })
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Slots) != n {
		t.Fatalf("Slots has %d entries, want %d", len(s.Slots), n)
	}
	type span struct{ start, end int }
	perWorker := make([][]span, 8)
	makespan := 0
	slot := make([]sched.Slot, n)
	for i, name := range names {
		sl, ok := s.Slots[name]
		if !ok {
			t.Fatalf("no slot for %q", name)
		}
		slot[i] = sl
		if sl.End-sl.Start != tasks[name].Duration || sl.Start < 0 {
			t.Fatalf("slot %+v does not match duration %d", sl, tasks[name].Duration)
		}
		if sl.Worker < 0 || sl.Worker >= 8 {
			t.Fatalf("worker %d out of range", sl.Worker)
		}
		perWorker[sl.Worker] = append(perWorker[sl.Worker], span{sl.Start, sl.End})
		if sl.End > makespan {
			makespan = sl.End
		}
	}
	for i := 0; i < n; i++ {
		for _, d := range depIdx[i] {
			if slot[i].Start < slot[d].End {
				t.Fatalf("%q starts at %d before its dependency %q ends at %d", names[i], slot[i].Start, names[d], slot[d].End)
			}
		}
	}
	for w, spans := range perWorker {
		sort.Slice(spans, func(a, b int) bool { return spans[a].start < spans[b].start })
		for k := 1; k < len(spans); k++ {
			if spans[k].start < spans[k-1].end {
				t.Fatalf("worker %d runs two tasks at once: %v and %v", w, spans[k-1], spans[k])
			}
		}
	}
	if s.Makespan != makespan {
		t.Fatalf("Makespan = %d, want %d", s.Makespan, makespan)
	}

	weight := make([]int, n) // indexes are already in dependency order
	for i := 0; i < n; i++ {
		best := 0
		for _, d := range depIdx[i] {
			if weight[d] > best {
				best = weight[d]
			}
		}
		weight[i] = best + tasks[names[i]].Duration
	}
	heavier := func(a, b int) bool { // a beats b
		if weight[a] != weight[b] {
			return weight[a] > weight[b]
		}
		return names[a] < names[b]
	}
	endTask := -1
	for i := 0; i < n; i++ {
		if slot[i].End == makespan && (endTask < 0 || heavier(i, endTask)) {
			endTask = i
		}
	}
	cp := s.CriticalPath
	if len(cp) == 0 || cp[len(cp)-1] != names[endTask] {
		t.Fatalf("CriticalPath must end at %q, got %d entries", names[endTask], len(cp))
	}
	for k := len(cp) - 1; k >= 0; k-- {
		cur := idx[cp[k]]
		best := -1
		for _, d := range depIdx[cur] {
			if best < 0 || heavier(d, best) {
				best = d
			}
		}
		if k == 0 {
			if best >= 0 {
				t.Fatalf("CriticalPath starts at %q, which still has dependencies", cp[0])
			}
		} else if best < 0 || cp[k-1] != names[best] {
			t.Fatalf("CriticalPath step before %q is %q, want the heaviest dependency", cp[k], cp[k-1])
		}
	}
}

func TestHiddenScaleLongRing(t *testing.T) {
	const ring, side = 100000, 50000
	rng := rand.New(rand.NewSource(7))
	order := rng.Perm(ring)
	rname := func(pos int) string { return fmt.Sprintf("r%06d", order[pos%ring]) }
	deps := make(map[string][]string, ring+2*side)
	for i := 0; i < side; i++ {
		// b tasks form an acyclic block the ring depends on
		var ds []string
		for k := rng.Intn(4); k > 0 && i > 0; k-- {
			ds = append(ds, fmt.Sprintf("b%06d", rng.Intn(i)))
		}
		deps[fmt.Sprintf("b%06d", i)] = ds
		// a tasks are a long chain hanging off the ring, not on any cycle
		next := fmt.Sprintf("a%06d", i+1)
		if i == side-1 {
			next = rname(rng.Intn(ring))
		}
		deps[fmt.Sprintf("a%06d", i)] = []string{next, rname(rng.Intn(ring))}
	}
	startPos := 0
	for p := 0; p < ring; p++ {
		ds := []string{rname(p + 1)}
		for k := rng.Intn(3); k > 0; k-- {
			ds = append(ds, fmt.Sprintf("b%06d", rng.Intn(side)))
		}
		deps[rname(p)] = ds
		if order[p] == 0 {
			startPos = p
		}
	}
	want := make([]string, 0, ring+1)
	for k := 0; k <= ring; k++ {
		want = append(want, rname(startPos+k))
	}
	expectCycleAtScale(t, "100000-task ring", deps, want)
}

func TestHiddenScaleManyTwoCycles(t *testing.T) {
	const pairs, tail = 50000, 100000
	rng := rand.New(rand.NewSource(99))
	perm := rng.Perm(2 * pairs)
	deps := make(map[string][]string, 2*pairs+tail)
	partner := ""
	for k := 0; k < pairs; k++ {
		x, y := fmt.Sprintf("c%06d", perm[2*k]), fmt.Sprintf("c%06d", perm[2*k+1])
		deps[x] = []string{y}
		deps[y] = []string{x}
		if x == "c000000" {
			partner = y
		} else if y == "c000000" {
			partner = x
		}
	}
	for i := 0; i < tail; i++ {
		// a long chain whose names sort first and which only leads into cycles
		next := fmt.Sprintf("a%06d", i+1)
		if i == tail-1 {
			next = fmt.Sprintf("c%06d", rng.Intn(2*pairs))
		}
		deps[fmt.Sprintf("a%06d", i)] = []string{next, fmt.Sprintf("c%06d", rng.Intn(2*pairs))}
	}
	expectCycleAtScale(t, "50000 separate 2-cycles", deps, []string{"c000000", partner, "c000000"})
}

func planOK(t *testing.T, tasks map[string][]string) [][]string {
	t.Helper()
	got, err := sched.Plan(tasks)
	if err != nil {
		t.Fatalf("Plan(%v) error: %v", tasks, err)
	}
	return got
}

func cycleOf(t *testing.T, tasks map[string][]string) *sched.CycleError {
	t.Helper()
	got, err := sched.Plan(tasks)
	var ce *sched.CycleError
	if !errors.As(err, &ce) {
		t.Fatalf("Plan(%v) = %v, %v; want a *CycleError", tasks, got, err)
	}
	if got != nil {
		t.Fatalf("Plan returned batches %v together with an error", got)
	}
	return ce
}

func unknownOf(t *testing.T, tasks map[string][]string) *sched.UnknownDepError {
	t.Helper()
	got, err := sched.Plan(tasks)
	var ue *sched.UnknownDepError
	if !errors.As(err, &ue) {
		t.Fatalf("Plan(%v) = %v, %v; want an *UnknownDepError", tasks, got, err)
	}
	if got != nil {
		t.Fatalf("Plan returned batches %v together with an error", got)
	}
	return ue
}

func wantPath(t *testing.T, tasks map[string][]string, want ...string) {
	t.Helper()
	ce := cycleOf(t, tasks)
	if !reflect.DeepEqual(ce.Path, want) {
		t.Fatalf("Plan(%v) cycle Path = %v, want %v", tasks, ce.Path, want)
	}
}

func TestHiddenPlanEmpty(t *testing.T) {
	for _, in := range []map[string][]string{{}, nil} {
		got, err := sched.Plan(in)
		if err != nil || got == nil || len(got) != 0 {
			t.Fatalf("Plan(%#v) = %#v, %v; want empty non-nil slice, nil", in, got, err)
		}
	}
}

func TestHiddenPlanBatches(t *testing.T) {
	cases := []struct {
		in   map[string][]string
		want [][]string
	}{
		{map[string][]string{"c": {"b"}, "b": {"a"}, "a": nil, "z": {}},
			[][]string{{"a", "z"}, {"b"}, {"c"}}},
		{map[string][]string{"top": nil, "right": {"top"}, "left": {"top"}, "bottom": {"right", "left"}},
			[][]string{{"top"}, {"left", "right"}, {"bottom"}}},
		{map[string][]string{"a": nil, "b": {"a"}, "c": {"a", "b", "a"}, "d": nil, "e": {"d"}, "f": {"c", "e"}},
			[][]string{{"a", "d"}, {"b", "e"}, {"c"}, {"f"}}},
	}
	for _, tc := range cases {
		if got := planOK(t, tc.in); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("Plan(%v) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestHiddenPlanUnknownDeps(t *testing.T) {
	ue := unknownOf(t, map[string][]string{"a": {"ghost"}, "ghost2": nil})
	if ue.Task != "a" || ue.Dep != "ghost" {
		t.Fatalf("UnknownDepError = %+v", ue)
	}
	if ue.Error() != `task "a" depends on unknown task "ghost"` {
		t.Fatalf("Error() = %q", ue.Error())
	}
	ue = unknownOf(t, map[string][]string{"m": {"x2", "x1"}, "k": {"m", "zz", "yy"}, "q": {"aa"}})
	if ue.Task != "k" || ue.Dep != "yy" {
		t.Fatalf("UnknownDepError = %+v, want Task k, Dep yy", ue)
	}
	ue = unknownOf(t, map[string][]string{"a": {"b"}, "b": {"a"}, "c": {"nope"}})
	if ue.Task != "c" || ue.Dep != "nope" {
		t.Fatalf("unknown dep must be reported before the cycle: %+v", ue)
	}
}

func TestHiddenPlanSimpleCycles(t *testing.T) {
	ce := cycleOf(t, map[string][]string{"a": nil, "b": {"b"}})
	if !reflect.DeepEqual(ce.Path, []string{"b", "b"}) || ce.Error() != "dependency cycle: b -> b" {
		t.Fatalf("self dependency: Path = %v, Error() = %q", ce.Path, ce.Error())
	}
	ce = cycleOf(t, map[string][]string{"a": nil, "w": {"x"}, "x": {"y"}, "y": {"z"}, "z": {"x"}})
	if !reflect.DeepEqual(ce.Path, []string{"x", "y", "z", "x"}) || ce.Error() != "dependency cycle: x -> y -> z -> x" {
		t.Fatalf("tail task must not count: Path = %v, Error() = %q", ce.Path, ce.Error())
	}
	wantPath(t, map[string][]string{"a": {"b"}, "b": {"c"}, "c": {"b"}, "d": {"e"}, "e": {"d"}}, "b", "c", "b")
}

func TestHiddenPlanCanonicalCycleWalk(t *testing.T) {
	// a dependency that cannot lead back is skipped
	wantPath(t, map[string][]string{"a": {"b", "c"}, "b": {"d"}, "d": nil, "c": {"a"}}, "a", "c", "a")
	// c only leads back through b, which is already on the path
	wantPath(t, map[string][]string{"a": {"b"}, "b": {"c", "d"}, "c": {"b"}, "d": {"a"}}, "a", "b", "d", "a")
	// lexicographic, not shortest
	wantPath(t, map[string][]string{"a": {"c", "b"}, "b": {"e"}, "e": {"a"}, "c": {"a"}}, "a", "b", "e", "a")
	// closes as soon as start is a dependency
	wantPath(t, map[string][]string{"a": {"m"}, "m": {"z", "a", "b"}, "b": {"m"}, "z": {"m"}}, "a", "m", "a")
	tasks := map[string][]string{
		"n1": {"n2", "n5"}, "n2": {"n3"}, "n3": {"n1", "n4"}, "n4": {"n2"}, "n5": {"n1"}, "n0": {"n3"},
	}
	for i := 0; i < 20; i++ {
		wantPath(t, tasks, "n1", "n2", "n3", "n1")
	}
}

func simOK(t *testing.T, tasks map[string]sched.Task, workers int) sched.Schedule {
	t.Helper()
	s, err := sched.Simulate(tasks, workers)
	if err != nil {
		t.Fatalf("Simulate error: %v", err)
	}
	return s
}

func checkSchedule(t *testing.T, label string, got sched.Schedule, slots map[string]sched.Slot, makespan int, path ...string) {
	t.Helper()
	if !reflect.DeepEqual(got.Slots, slots) {
		t.Fatalf("%s: Slots = %+v\nwant %+v", label, got.Slots, slots)
	}
	if got.Makespan != makespan {
		t.Fatalf("%s: Makespan = %d, want %d", label, got.Makespan, makespan)
	}
	if !reflect.DeepEqual(got.CriticalPath, path) {
		t.Fatalf("%s: CriticalPath = %v, want %v", label, got.CriticalPath, path)
	}
}

func TestHiddenSimulateEmpty(t *testing.T) {
	for _, in := range []map[string]sched.Task{{}, nil} {
		s := simOK(t, in, 2)
		if s.Slots == nil || len(s.Slots) != 0 || s.Makespan != 0 || s.CriticalPath == nil || len(s.CriticalPath) != 0 {
			t.Fatalf("Simulate(%#v) = %#v; want empty non-nil Slots and CriticalPath, Makespan 0", in, s)
		}
	}
}

func TestHiddenSimulatePriorityOrder(t *testing.T) {
	s := simOK(t, map[string]sched.Task{
		"a": {Duration: 2, Priority: 1},
		"b": {Duration: 1, Priority: 3},
		"c": {Duration: 5, Priority: 3},
		"d": {Duration: 2, Priority: 1},
	}, 1)
	checkSchedule(t, "one worker", s, map[string]sched.Slot{
		"c": {Start: 0, End: 5, Worker: 0},
		"b": {Start: 5, End: 6, Worker: 0},
		"a": {Start: 6, End: 8, Worker: 0},
		"d": {Start: 8, End: 10, Worker: 0},
	}, 10, "d")
}

func TestHiddenSimulateWorkerNumbering(t *testing.T) {
	s := simOK(t, map[string]sched.Task{
		"a": {Duration: 5},
		"b": {Duration: 2},
		"c": {Duration: 3},
		"d": {Duration: 1},
		"e": {Duration: 1},
	}, 3)
	checkSchedule(t, "three workers", s, map[string]sched.Slot{
		"a": {Start: 0, End: 5, Worker: 0},
		"c": {Start: 0, End: 3, Worker: 1},
		"b": {Start: 0, End: 2, Worker: 2},
		"d": {Start: 2, End: 3, Worker: 2},
		"e": {Start: 3, End: 4, Worker: 1},
	}, 5, "a")

	// worker 2 has been idle since t=1, but worker 1 is the lowest free one at t=3
	s = simOK(t, map[string]sched.Task{
		"p": {Duration: 4, Priority: 5},
		"q": {Duration: 3, Priority: 4},
		"r": {Duration: 1, Priority: 3},
		"s": {Duration: 2, Deps: []string{"q"}},
	}, 3)
	checkSchedule(t, "lowest free worker", s, map[string]sched.Slot{
		"p": {Start: 0, End: 4, Worker: 0},
		"q": {Start: 0, End: 3, Worker: 1},
		"r": {Start: 0, End: 1, Worker: 2},
		"s": {Start: 3, End: 5, Worker: 1},
	}, 5, "q", "s")
}

func TestHiddenSimulateCompletionsBeforeStarts(t *testing.T) {
	// hi is released by a at t=2 and must win the free worker over low
	s := simOK(t, map[string]sched.Task{
		"a":   {Duration: 2},
		"b":   {Duration: 3},
		"low": {Duration: 1, Priority: -5},
		"hi":  {Duration: 1, Priority: 9, Deps: []string{"a"}},
	}, 2)
	checkSchedule(t, "release before start", s, map[string]sched.Slot{
		"b":   {Start: 0, End: 3, Worker: 0},
		"a":   {Start: 0, End: 2, Worker: 1},
		"hi":  {Start: 2, End: 3, Worker: 1},
		"low": {Start: 3, End: 4, Worker: 0},
	}, 4, "low")

	// both dependencies finish at t=2 and z starts at t=2
	s = simOK(t, map[string]sched.Task{
		"y": {Duration: 2},
		"x": {Duration: 2},
		"z": {Duration: 1, Deps: []string{"y", "x", "y"}},
	}, 3)
	checkSchedule(t, "simultaneous completion", s, map[string]sched.Slot{
		"x": {Start: 0, End: 2, Worker: 0},
		"y": {Start: 0, End: 2, Worker: 1},
		"z": {Start: 2, End: 3, Worker: 0},
	}, 3, "x", "z")
}

func TestHiddenSimulateCriticalPath(t *testing.T) {
	s := simOK(t, map[string]sched.Task{
		"a": {Duration: 2},
		"b": {Duration: 3, Deps: []string{"a"}},
		"c": {Duration: 3, Deps: []string{"a"}},
		"d": {Duration: 1, Deps: []string{"c", "b"}},
	}, 2)
	checkSchedule(t, "diamond tie", s, map[string]sched.Slot{
		"a": {Start: 0, End: 2, Worker: 0},
		"b": {Start: 2, End: 5, Worker: 0},
		"c": {Start: 2, End: 5, Worker: 1},
		"d": {Start: 5, End: 6, Worker: 0},
	}, 6, "a", "b", "d")

	s = simOK(t, map[string]sched.Task{
		"a": {Duration: 1},
		"b": {Duration: 1, Deps: []string{"a"}},
		"c": {Duration: 4},
		"d": {Duration: 1, Deps: []string{"b", "c"}},
	}, 2)
	checkSchedule(t, "heavier chain wins", s, map[string]sched.Slot{
		"c": {Start: 0, End: 4, Worker: 0},
		"a": {Start: 0, End: 1, Worker: 1},
		"b": {Start: 1, End: 2, Worker: 1},
		"d": {Start: 4, End: 5, Worker: 0},
	}, 5, "c", "d")

	// zbig and tail both end at 5; zbig's chain weight 5 beats tail's 4 (two then tail)
	s = simOK(t, map[string]sched.Task{
		"zbig": {Duration: 5, Priority: 9},
		"one":  {Duration: 1, Priority: 8},
		"two":  {Duration: 1, Priority: 7},
		"tail": {Duration: 3, Deps: []string{"two"}},
	}, 2)
	checkSchedule(t, "end task by chain weight", s, map[string]sched.Slot{
		"zbig": {Start: 0, End: 5, Worker: 0},
		"one":  {Start: 0, End: 1, Worker: 1},
		"two":  {Start: 1, End: 2, Worker: 1},
		"tail": {Start: 2, End: 5, Worker: 1},
	}, 5, "zbig")

	s = simOK(t, map[string]sched.Task{"y": {Duration: 3}, "x": {Duration: 3}}, 2)
	checkSchedule(t, "end task tie", s, map[string]sched.Slot{
		"x": {Start: 0, End: 3, Worker: 0},
		"y": {Start: 0, End: 3, Worker: 1},
	}, 3, "x")
}

func TestHiddenSimulateErrors(t *testing.T) {
	bad := map[string]sched.Task{"a": {Duration: 0}}
	for _, w := range []int{0, -3} {
		if _, err := sched.Simulate(bad, w); !errors.Is(err, sched.ErrNoWorkers) {
			t.Fatalf("Simulate(workers=%d) err = %v, want ErrNoWorkers", w, err)
		}
	}
	_, err := sched.Simulate(map[string]sched.Task{
		"b": {Duration: 0},
		"a": {Duration: -1},
		"c": {Duration: 1, Deps: []string{"ghost"}},
	}, 1)
	var de *sched.InvalidDurationError
	if !errors.As(err, &de) || de.Task != "a" {
		t.Fatalf("err = %v, want *InvalidDurationError for a", err)
	}
	if de.Error() != `task "a" has a non-positive duration` {
		t.Fatalf("Error() = %q", de.Error())
	}
	_, err = sched.Simulate(map[string]sched.Task{
		"a": {Duration: 1, Deps: []string{"b"}},
		"b": {Duration: 1, Deps: []string{"a"}},
		"c": {Duration: 1, Deps: []string{"ghost"}},
	}, 2)
	var ue *sched.UnknownDepError
	if !errors.As(err, &ue) || ue.Task != "c" || ue.Dep != "ghost" {
		t.Fatalf("err = %v, want *UnknownDepError{c ghost}", err)
	}
	_, err = sched.Simulate(map[string]sched.Task{
		"a": {Duration: 1, Deps: []string{"b"}},
		"b": {Duration: 1, Deps: []string{"c", "d"}},
		"c": {Duration: 1, Deps: []string{"b"}},
		"d": {Duration: 1, Deps: []string{"a"}},
	}, 2)
	var ce *sched.CycleError
	if !errors.As(err, &ce) || !reflect.DeepEqual(ce.Path, []string{"a", "b", "d", "a"}) {
		t.Fatalf("err = %v, want *CycleError [a b d a]", err)
	}
}
