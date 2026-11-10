"""Loads one dotenv file with the pinned python-dotenv and prints the result as JSON.

Usage: python check.py <file>

`dotenv_values` is what `load_dotenv` uses to read a file; interpolation is on,
as it is by default. Output is ASCII-only JSON on stdout.
"""

import importlib.metadata
import json
import sys

from dotenv import dotenv_values


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: check.py <file>\n")
        return 2
    values = dotenv_values(sys.argv[1], interpolate=True, encoding="utf-8")
    result = {
        "version": importlib.metadata.version("python-dotenv"),
        "values": dict(values),
    }
    sys.stdout.write(json.dumps(result, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
