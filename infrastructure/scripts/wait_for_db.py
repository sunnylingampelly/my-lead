"""Block until the database accepts connections (used before running migrations)."""
import sys
import time

from sqlalchemy import create_engine, text

from app.core.config import settings

deadline = time.time() + 120
while True:
    try:
        with create_engine(settings.DATABASE_URL).connect() as conn:
            conn.execute(text("SELECT 1"))
        print("database ready")
        break
    except Exception as exc:  # noqa: BLE001
        if time.time() > deadline:
            print(f"database not ready: {type(exc).__name__}", file=sys.stderr)
            sys.exit(1)
        time.sleep(2)
