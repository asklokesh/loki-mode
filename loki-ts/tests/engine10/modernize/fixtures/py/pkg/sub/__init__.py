# `thing` is an attribute of pkg/util.py, not a submodule -- exercises resolve()'s
# fallback branch (falls back to the "from" target itself when name+".py" isn't a file).
from pkg.util import thing
