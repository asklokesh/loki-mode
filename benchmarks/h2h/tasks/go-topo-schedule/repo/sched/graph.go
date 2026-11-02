// Package sched plans the order in which build tasks run.
package sched

import "sort"

// Dependents inverts a task -> dependencies map into dependency -> tasks
// that depend on it. Every key of tasks appears in the result (possibly with
// an empty list) and each list is sorted ascending without duplicates.
func Dependents(tasks map[string][]string) map[string][]string {
	sets := map[string]map[string]bool{}
	for task, deps := range tasks {
		if sets[task] == nil {
			sets[task] = map[string]bool{}
		}
		for _, d := range deps {
			if sets[d] == nil {
				sets[d] = map[string]bool{}
			}
			sets[d][task] = true
		}
	}
	out := make(map[string][]string, len(sets))
	for node, set := range sets {
		list := make([]string, 0, len(set))
		for t := range set {
			list = append(list, t)
		}
		sort.Strings(list)
		out[node] = list
	}
	return out
}
