"""Restore a backup made by scripts/backup_db.py into a NEW database.

    python scripts/restore_db.py --target signalcraft_restore_check                 # newest backup
    python scripts/restore_db.py var/backups/signalcraft_20261124_0300.sql.gz --target signalcraft_copy
    python scripts/restore_db.py --target signalcraft_restore_check --compare-with signalcraft_dev --drop-after

It refuses to touch an existing database unless --force is given (then it is dropped and recreated), and it
never restores into a system database or the `live` database. Connection details come from DATABASE_URL;
the mysql client from MYSQL_PATH (default: on PATH, else next to mysqldump in D:\\xxmp\\mysql\\bin).
"""
import argparse
import gzip
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backup_db import client_env, conn_args, db_params, find_tool, newest_backup  # noqa: E402

PROTECTED = {"live", "mysql", "information_schema", "performance_schema", "sys"}
NAME_OK = re.compile(r"^[A-Za-z0-9_]{1,64}$")


def connect(params: dict, database: str | None = None):
    import pymysql

    return pymysql.connect(host=params["host"], port=int(params["port"]), user=params["user"],
                           password=params["password"], database=database, charset="utf8mb4", autocommit=True)


def database_exists(params: dict, name: str) -> bool:
    with connect(params) as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = %s", (name,))
        return cur.fetchone() is not None


def table_counts(params: dict, name: str) -> dict[str, int]:
    """Exact row count per base table (COUNT(*), not the InnoDB estimate)."""
    with connect(params, name) as conn, conn.cursor() as cur:
        cur.execute("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s "
                    "AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME", (name,))
        tables = [r[0] for r in cur.fetchall()]
        out = {}
        for t in tables:
            cur.execute(f"SELECT COUNT(*) FROM `{t}`")  # noqa: S608 - names from information_schema
            out[t] = cur.fetchone()[0]
        return out


def check_target(target: str, source_db: str, force: bool) -> None:
    if not NAME_OK.match(target):
        raise SystemExit("--target may only contain letters, digits and underscores")
    if target.lower() in PROTECTED:
        raise SystemExit(f"refusing to restore into protected database '{target}'")
    if target == source_db and not force:
        raise SystemExit(f"'{target}' is the application's own database; pass --force to overwrite it")


def restore(params: dict, backup: Path, target: str, force: bool) -> None:
    if database_exists(params, target):
        if not force:
            raise SystemExit(f"database '{target}' already exists; choose a new name or pass --force")
        with connect(params) as conn, conn.cursor() as cur:
            cur.execute(f"DROP DATABASE `{target}`")
    with connect(params) as conn, conn.cursor() as cur:
        cur.execute(f"CREATE DATABASE `{target}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
    cmd = [find_tool("mysql", "MYSQL_PATH"), *conn_args(params), "--default-character-set=utf8mb4", target]
    # Argument list, no shell; `target` was validated by check_target().
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE, env=client_env(params))  # noqa: S603
    try:
        with gzip.open(backup, "rb") as src:
            for chunk in iter(lambda: src.read(1 << 20), b""):
                proc.stdin.write(chunk)
        proc.stdin.close()
    except BrokenPipeError:
        pass
    stderr = proc.stderr.read().decode(errors="replace")
    if proc.wait() != 0:
        raise SystemExit(f"mysql failed while restoring: {stderr.strip()[:500]}")


def compare(params: dict, source: str, target: str) -> bool:
    a, b = table_counts(params, source), table_counts(params, target)
    print(f"tables: {source}={len(a)} {target}={len(b)}")
    ok = set(a) == set(b)
    for t in sorted(set(a) | set(b)):
        if a.get(t) != b.get(t):
            ok = False
            print(f"  MISMATCH {t}: {a.get(t)} vs {b.get(t)}")
    print(f"rows: {source}={sum(a.values()):,} {target}={sum(b.values()):,}")
    print("MATCH: every table and row count is identical" if ok else "DIFFERENCES FOUND")
    return ok


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Restore a backup into a new database.")
    ap.add_argument("backup", nargs="?", type=Path, help="a .sql.gz file (default: the newest backup)")
    ap.add_argument("--target", required=True, help="name of the database to create")
    ap.add_argument("--force", action="store_true", help="drop and recreate the target if it exists")
    ap.add_argument("--compare-with", metavar="DB", help="afterwards compare table and row counts with DB")
    ap.add_argument("--drop-after", action="store_true", help="drop the target when done (restore checks)")
    args = ap.parse_args(argv)
    params = db_params()
    backup = args.backup or newest_backup()
    if backup is None or not Path(backup).exists():
        raise SystemExit("no backup file found")
    check_target(args.target, params["database"], args.force)
    print(f"restoring {backup} into {args.target}")
    restore(params, Path(backup), args.target, args.force)
    print("restore complete")
    ok = compare(params, args.compare_with, args.target) if args.compare_with else True
    if args.drop_after:
        with connect(params) as conn, conn.cursor() as cur:
            cur.execute(f"DROP DATABASE `{args.target}`")
        print(f"dropped {args.target}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
