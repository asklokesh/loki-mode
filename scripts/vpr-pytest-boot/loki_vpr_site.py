import importlib.util, os, sys
import loki_vpr_boot
loki_vpr_boot.early()
# Shadows the interpreter's own sitecustomize on PYTHONPATH so the recorder starts first, then runs the next sitecustomize
# on sys.path (a distribution may use it to set up its site-packages).
_me = os.path.dirname(os.path.abspath(__file__))
for _d in sys.path:
    _f = os.path.join(_d or ".", "sitecustomize.py")
    if os.path.dirname(os.path.abspath(_f)) != _me and os.path.isfile(_f):
        _s = importlib.util.spec_from_file_location("sitecustomize_next", _f)
        _m = importlib.util.module_from_spec(_s)
        _s.loader.exec_module(_m)
        break
