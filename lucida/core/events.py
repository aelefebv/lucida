from collections import defaultdict
from typing import Any, ClassVar, TypeVar, Callable
from dataclasses import dataclass, is_dataclass
from lucida.core import logging as log

@dataclass(slots=True, frozen=True)
class Event: 
    __log__: ClassVar[bool] = False
E = TypeVar("E", bound=Event)
Handler = Callable[[E], None]

class SignalBus:
    def __init__(self) -> None:
        self._subs: dict[type, set[Callable]] = defaultdict(set)
        self._log_info = log.log_info

    # Event API ---- ---- ----
    def subscribe(self, event_type: type[E], fn: Handler[E]) -> None:
        self._subs[event_type].add(fn)

    def unsubscribe(self, event_type: type[E], fn: Handler[E]) -> None:
        self._subs[event_type].discard(fn)

    def emit(self, event: Event) -> None:
        evt_type = event.__class__
        handlers = self._subs.get(evt_type)
        if handlers:
            for fn in handlers:
                fn(event)
                
        if log._logger and event.__log__:
            self._log_info(
                event.__class__.__name__,
                event=event.__class__.__name__,
                **_event_payload(event)
            )
                
def _event_payload(e: Event) -> dict[str, Any]:
    if is_dataclass(e) and not isinstance(e, tuple):   # small guard vs namedtuple
        return {f.name: getattr(e, f.name) for f in e.__dataclass_fields__.values() if not f.name.startswith("_")}
    return {k: v for k, v in e.__dict__.items() if not k.startswith("_")}
