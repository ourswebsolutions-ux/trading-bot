"""Entry point used by the desktop app: `python -E -s -u run_engine.py`.

Running a script (rather than `-m`) makes Python put this directory, and only this
directory, at the front of sys.path, so the bundled package is always the one imported.
"""

from tradepilot_engine.protocol import serve

if __name__ == "__main__":
    serve()
