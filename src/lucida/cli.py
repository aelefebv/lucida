"""Entrypoint for the Lucida Typer CLI."""

from __future__ import annotations

from lucida.commands import app


def main() -> None:
    """Launch the Typer application."""
    app()


if __name__ == "__main__":
    main()
