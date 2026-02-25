"""Top-level module entrypoint for the Lucida CLI."""

from lucida.cli import main as lucida_main


def main() -> None:
    """Run the main CLI entrypoint."""
    lucida_main()


if __name__ == "__main__":
    main()
