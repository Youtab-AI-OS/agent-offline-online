"""Seam for the server.py @method handler split (mechanical move).

server.py's ~130 JSON-RPC handlers close over its module globals
(``_sessions``, ``_ok``, ``_err``, config helpers, ...).  To move them
out of the 19K-line module without rewriting a single handler body,
each ``methods_*`` module defines its handlers under a local
:class:`HandlerRegistry` and server.py calls :meth:`HandlerRegistry.install`
at the end of its own import, once every global the handlers close over
exists.  ``install()`` rebinds each handler's ``__globals__`` to
server.py's namespace with ``types.FunctionType``, so handler bodies
stay byte-identical and ``global X`` statements inside handlers keep
mutating server.py state exactly as before the split.

No import cycle: ``methods_*`` modules never import server at module
level — server imports them and passes itself to ``register()``.
"""

import sys
import types


def bind_server_function(fn, server):
    """Keep the same shared server namespace for source and native handlers."""
    module = sys.modules.get(fn.__module__)
    native_bind = getattr(module, "__youtab_bind_globals__", None)
    if native_bind is not None:
        namespace = vars(server)
        for key, value in vars(module).items():
            if not key.startswith("__"):
                namespace.setdefault(key, value)
        native_bind(namespace)
        return fn
    real = types.FunctionType(
        fn.__code__, vars(server), fn.__name__, fn.__defaults__, fn.__closure__
    )
    real.__kwdefaults__ = fn.__kwdefaults__
    real.__doc__ = fn.__doc__
    real.__dict__.update(fn.__dict__)
    return real


class HandlerRegistry:
    """Deferred @method registrar used by the methods_* split modules."""

    def __init__(self) -> None:
        self._pending: list[tuple[str, types.FunctionType]] = []

    def method(self, name: str):
        """Drop-in for server.py's ``@method`` decorator (defers registration)."""

        def dec(fn):
            self._pending.append((name, fn))
            return fn

        return dec

    def profile_scoped(self, fn):
        """Drop-in for server.py's ``@_profile_scoped`` (applied at install)."""
        fn._youtab_profile_scoped = True
        return fn

    def install(self, server) -> None:
        """Rebind pending handlers onto ``server``'s globals and register them."""
        for name, fn in self._pending:
            real = bind_server_function(fn, server)
            if getattr(fn, "_youtab_profile_scoped", False):
                real = server._profile_scoped(real)
            server._methods[name] = real
