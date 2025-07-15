from dataclasses import dataclass
from typing import ClassVar


@dataclass(slots=True, frozen=True)
class Event:
    __log__: ClassVar[bool] = True
    _ignore_attrs: ClassVar[set[str]] = set()
    

@dataclass(slots=True, frozen=True)
class DimIndexChanged(Event):
    """Emitted by GUI controls when a dimension index is moved."""
    dim: str      # e.g. 'T', 'C', 'Z'
    value: int    # new integer index
    
