from __future__ import annotations
try:
    from IPython.core.interactiveshell import InteractiveShell
except ImportError:
    pass

def get_current_ipython() -> InteractiveShell | None:
    """Get the current IPython instance, or None if not in IPython."""
    try:
        from IPython.core.getipython import get_ipython
        if ip := get_ipython():
            ip.run_line_magic("gui", "qt")  # Ensure Qt event loop integration
        return ip
    except ImportError: 
        return None