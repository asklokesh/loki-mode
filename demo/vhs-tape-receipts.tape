# Loki Mode - VHS Tape (Segment B: completion receipts)
#
# Companion to demo/vhs-tape.tape (Segment A). This captures the completion
# receipts terminal segment ONLY, run after a real build has finished.
#
# This tape runs the REAL commands against real state. It does not print
# fabricated output. Run it from inside the recording directory AFTER a
# completed `loki start` run:
#   cd ~/loki-demo-recording/notes-app
#   vhs /Users/lokesh/git/loki-mode/demo/vhs-tape-receipts.tape
#
# Requirements:
#   - .loki/COMPLETION.txt exists (a completed run).
#   - The built app is still running (so `loki preview` prints a live URL).
#     If it is not, COMPLETION.txt still shows the diff receipts; the live-app
#     line is only present when the app was running at run close.
#   - vhs v0.11.0.
#
# No emojis. No em dashes or en dashes. Plain hyphens only.

Output demo/recordings/loki-segment-b-receipts.gif
Output demo/recordings/loki-segment-b-receipts.mp4

Set FontSize 16
Set Width 1280
Set Height 800
Set Theme "Catppuccin Mocha"
Set Padding 24
Set TypingSpeed 55ms
Set Shell "bash"

# The receipts. This is the real durable summary Loki writes at run close.
Type "cat .loki/COMPLETION.txt"
Sleep 800ms
Enter
Sleep 7s

# The live URL and status, printed without re-opening the browser.
Type "loki preview --no-open"
Sleep 800ms
Enter
Sleep 6s
