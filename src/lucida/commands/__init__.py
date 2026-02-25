"""Composable Typer command groups for the Lucida CLI."""

from __future__ import annotations

import typer

from .dataset import dataset_app
from .render import render_app
from .session import session_app
from .usage import usage_app
from .view import view_app

app = typer.Typer(no_args_is_help=True)
app.add_typer(dataset_app, name="dataset")
app.add_typer(session_app, name="session")
app.add_typer(view_app, name="view")
app.add_typer(render_app, name="render")
app.add_typer(usage_app, name="usage")

__all__ = [
    "app",
    "dataset_app",
    "session_app",
    "view_app",
    "render_app",
    "usage_app",
]
