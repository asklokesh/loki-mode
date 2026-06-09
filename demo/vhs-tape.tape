# Loki Mode - VHS Tape (terminal bookends only)
#
# This tape captures ONLY the crisp terminal segments of the demo:
#   Segment A: typing `loki start prd.md` plus the real early build output.
#   Segment B: the completion receipts (cat .loki/COMPLETION.txt + loki preview).
#
# The long build middle and all dashboard / live-app footage are SCREEN-RECORDED,
# not captured here. See demo/youtube-demo-script.md (recording runbook).
#
# This tape runs the REAL commands. It does not print fabricated output.
# Run it from inside the isolated recording directory so it captures real state:
#   cd ~/loki-demo-recording/notes-app
#   vhs /Users/lokesh/git/loki-mode/demo/vhs-tape.tape
#
# Requirements before running:
#   - prd.md present in the current directory (the notes-app spec).
#   - For Segment B: a completed run, so .loki/COMPLETION.txt exists.
#   - vhs v0.11.0.
#
# No emojis. No em dashes or en dashes. Plain hyphens only.

Output demo/recordings/loki-segment-a-start.gif
Output demo/recordings/loki-segment-a-start.mp4

Set FontSize 16
Set Width 1280
Set Height 800
Set Theme "Catppuccin Mocha"
Set Padding 24
Set TypingSpeed 55ms
Set Shell "bash"

# --- Segment A: one command, real early build output ---------------------------

# Show the spec briefly so the viewer sees this is a real multi-service spec.
Type "cat prd.md"
Enter
Sleep 4s

# Clear and run the actual build.
Type "clear"
Enter
Sleep 500ms

Type "loki start prd.md"
Sleep 1s
Enter

# Capture the genuine early output: bootstrap, discovery, iteration 1.
# 55 seconds is a realistic window for the opening of a real run. The full
# build continues beyond this; the rest is screen-recorded per the runbook.
Sleep 55s
