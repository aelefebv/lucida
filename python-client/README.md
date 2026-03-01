# lucida-py

Python bindings for Lucida canonical commands.

## Jupyter Embed Route Contract

`lucida_py.jupyter.create_widget_shell(...)` emits a browser iframe URL using the
`client-web` viewer route contract:

- required query params: `session`, `client`
- optional query params: `wsBase`, `dataBase`

Example:

```python
from lucida_py.jupyter import create_widget_shell

shell = create_widget_shell(
    base_url="http://127.0.0.1:5173",
    session_id="sess_00000001",
    client_id="cli_00000001",
    ws_base="ws://127.0.0.1:8787",
    data_base="http://127.0.0.1:8787",
)
shell.display()
```

## Development

```bash
cd python-client
python -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
pytest
```
