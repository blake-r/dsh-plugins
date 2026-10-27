# @blake-r/dsh-tool-python

`py_run` / `py_pip` tools over a per-workspace Python venv, with on-the-fly
repair of a relocated venv.

## Install

From npm (published):

```bash
dsh plugin --profile web add @blake-r/dsh-tool-python
```

From the GitHub repo (selective, subdirectory):

```bash
dsh plugin --profile web add github:blake-r/dsh-plugins#path:packages/dsh-tool-python
```

## What it does

The plugin manages a per-workspace venv at `<cwd>/.dsh/pyenv`. `py_run`
executes an existing `.py` file in that venv (or the system python when the
venv does not exist yet); `py_pip` creates the venv on first use and installs
packages into it. Python subprocesses are confined through the same DSH
sandbox seam the bash tool uses.

When the workspace directory moves, the venv moves with it but its hardcoded
paths (console-script shebangs, activate scripts, `pyvenv.cfg`, and the
`__pycache__` bytecode) still point at the old location. Before every run the
plugin detects a stale venv and rewrites old-path -> new-path in place, so a
relocated workspace keeps working transparently without recreating the venv
(which would lose installed packages). See the header comment in
`src/dsh-tool-python.mjs` for full behavior.
