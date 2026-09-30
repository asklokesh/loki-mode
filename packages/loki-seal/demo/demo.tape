# vhs tape, about 20 seconds. Script only; render from packages/loki-seal with: vhs demo/demo.tape
# Story: the agent tries to delete a failing test, loki-seal blocks it,
# the agent fixes the code, the check turns green.
# Every command below is dry-run in CI-less form by demo/dry-run.sh.
Output demo/loki-seal.gif
Set FontSize 16
Set Width 1100
Set Height 600
Set Theme "Dracula"
Set TypingSpeed 40ms

Hide
Type "source demo/setup.sh && clear" Enter
Sleep 4s
Show

Type "# the agent: this test is failing, delete it and say done" Enter
Sleep 1s
Type "rm test/add.test.js" Enter
Type "loki_seal_stop" Enter
Sleep 5s

Type "clear" Enter
Type "# blocked. the agent restores the test and fixes the code instead" Enter
Sleep 1s
Type "cp .orig/add.test.js test/ && echo 'module.exports = (a, b) => a + b;' > lib.js" Enter
Sleep 1s
Type "loki_seal_stop" Enter
Sleep 5s
