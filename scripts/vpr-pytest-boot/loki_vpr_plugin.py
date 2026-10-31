import sys, pytest, loki_vpr_boot as b
# Wraps the plugin manager's conftest and plugin imports so the recorder knows when one is running, ends the start-up
# window at pytest_sessionstart and writes the terminator at pytest_unconfigure, the last hook, so deferred loading is
# inside the record. Every hook call that has a repo-file implementation (a conftest or a repo-local plugin) is also in
# the window, and the file of every plugin registered at any time is noted. Installed third-party plugins stay outside
# (not PR-controlled). Test-module collection and fixtures are outside: the issue's test and the code under test are
# meant to change. A conftest implementing pytest_runtest_call puts the test body in the window, which can only over-flag.
b.snap()
def _wrap(f):
    def w(*a, **k):
        b.enter()
        try: return f(*a, **k)
        finally: b.leave()
    return w
@pytest.hookimpl(tryfirst=True)
def pytest_load_initial_conftests(early_config, parser, args):
    b.snap()
    pm = early_config.pluginmanager
    for n in ("_importconftest", "import_plugin"):
        setattr(pm, n, _wrap(getattr(pm, n)))
    reg = pm.register
    def register(plugin, name=None):
        b.note(getattr(plugin, "__file__", None) or getattr(sys.modules.get(getattr(type(plugin), "__module__", ""), None), "__file__", None))
        return reg(plugin, name)
    pm.register = register
    def before(hook_name, hook_impls, kwargs):
        if any(b.inrepo(i.plugin) for i in hook_impls): b.enter()
    def after(outcome, hook_name, hook_impls, kwargs):
        if any(b.inrepo(i.plugin) for i in hook_impls): b.leave()
    pm.add_hookcall_monitoring(before, after)
@pytest.hookimpl(tryfirst=True)
def pytest_sessionstart(session): b.boot_end()
@pytest.hookimpl(trylast=True)
def pytest_unconfigure(config): b.finish()
