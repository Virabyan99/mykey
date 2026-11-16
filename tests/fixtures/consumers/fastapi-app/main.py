# Run 5.8 consumer fixture. GET /check: the names of FIXTURE_NAMES
# (comma-separated) that are set in this process's environment, and the
# SHA-256 of each value. Never a value.
import hashlib
import os

from fastapi import FastAPI

app = FastAPI()


@app.get("/check")
def check() -> dict:
    wanted = [name for name in os.environ.get("FIXTURE_NAMES", "").split(",") if name]
    names = [name for name in wanted if name in os.environ]
    digests = {
        name: hashlib.sha256(os.environ[name].encode("utf-8")).hexdigest() for name in names
    }
    return {"names": names, "digests": digests}
