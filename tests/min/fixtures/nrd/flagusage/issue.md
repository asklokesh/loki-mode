Help should list the short alias first

Every other tool we ship lists a flag's short alias first in its help output, like `-o, --output`. This package prints the long name first.

`FlagLine(Flag{Name: "output", Short: "o", Usage: "write to file"})` returns:

    "  --output, -o\twrite to file"

Expected:

    "  -o, --output\twrite to file"

Flags without a short alias keep printing just the long name, for example `"  --verbose\tprint more"`.

Preferred fix: put the short alias first where the help line renders the flag's names.
