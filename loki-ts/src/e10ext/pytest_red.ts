// E-125 r5: does pytest exit-1 output show a real test failure? Only the final summary counts, never captured text.
// Runner appends -rf, so a repo's `-q` addopts (which stacks to -qq and drops the footer) still lists `FAILED ...` lines.
export function pytestExit1IsRed(output: string): boolean {
  if (/^!+ _pytest\.outcomes\.Exit\b/m.test(output)) return false; // pytest.exit(...) can print any text, incl. "1 failed"
  const last = output.trimEnd().split("\n").pop() ?? "";
  if (/^=*\s*(\d+ \w+(, )?)*\d+ failed\b.* in [\d.]+s/.test(last)) return true;
  const hdr = [...output.matchAll(/^=+ short test summary info =+$/gm)].pop();
  return !!hdr && /^FAILED \S+/m.test(output.slice(hdr.index));
}
