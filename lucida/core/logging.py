import logging
import os
from datetime import datetime
from typing import Any
from pathlib import Path

__all__ = [
    "init_logging",
    "log_debug",
    "log_info",
    "log_warning",
    "log_error",
    "log_critical",
]

class CompactFormatter(logging.Formatter):
    standard = {
        "name", "msg", "args", "levelname", "levelno", "pathname",
        "filename", "module", "exc_info", "exc_text", "stack_info",
        "lineno", "funcName", "created", "msecs", "relativeCreated",
        "thread", "threadName", "processName", "process", "message",
        "asctime", "taskName"
    }

    def __init__(self) -> None:
        super().__init__(datefmt="%H:%M:%S")

    def format(self, record: logging.LogRecord) -> str:
        extras: dict[str, Any] = {
            k: v for k, v in record.__dict__.items()
            if k not in self.standard
        }

        parts = [
            self.formatTime(record, self.datefmt),
            record.levelname,
            record.getMessage(),
        ]
        parts.extend(f"{k}={v}" for k, v in extras.items())
        return "  |  ".join(parts)
    
def _emit(level: int, msg: str, *args: Any, **kw: Any) -> None:
    if _logger is None: init_logging()
    if _logger is not None:
        _logger.log(level, msg, *args, extra=kw)

# ------- Public API
_logger: logging.Logger | None = None
def init_logging(
    *,
    level: str | int = "INFO",
    std_out: bool = False,
) -> None:
    """Configure root logger once."""
    global _logger
    if _logger:     # already initialised
        return

    # Will appear in `GAME_LOGDIR` env var, else `logs/`
    LOG_DIR = Path(os.environ.get("LOGDIR", "logs"))
    log_path = LOG_DIR / "%Y%m%d_%H%M%S.log"

    # base logger
    base = logging.getLogger("logger")
    base.setLevel(level)

    fmt = CompactFormatter()

    # stdout
    if std_out:
        sh = logging.StreamHandler()
        sh.setFormatter(fmt)
        base.addHandler(sh)
        
    # allow %Y-%m-%d patterns
    path = datetime.now().strftime(str(log_path))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fh = logging.FileHandler(path, encoding="utf-8")
    fh.setFormatter(fmt)
    base.addHandler(fh)

    _logger = base

def log_debug(msg: str, *a: Any, **k: Any) -> None: _emit(logging.DEBUG, msg, *a, **k)
def log_info(msg: str, *a: Any, **k: Any) -> None: _emit(logging.INFO, msg, *a, **k)
def log_warning(msg: str, *a: Any, **k: Any) -> None: _emit(logging.WARNING, msg, *a, **k)
def log_error(msg: str, *a: Any, **k: Any) -> None: _emit(logging.ERROR, msg, *a, **k)
def log_critical(msg: str, *a: Any, **k: Any) -> None: _emit(logging.CRITICAL, msg, *a, **k)
