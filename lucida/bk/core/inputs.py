from dataclasses import dataclass

from lucida.core.events import Event

@dataclass(slots=True, frozen=True)
class KeyPressed(Event):
    key: str
    modifiers: tuple[str, ...] = ()
