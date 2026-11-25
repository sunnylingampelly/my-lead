"""Back up the Signalcraft MySQL/MariaDB database with mysqldump, gzip it, and prune old backups.

    python scripts/backup_db.py                     # dump + prune
    python scripts/backup_db.py --keep-daily 14 --keep-weekly 8
    python scripts/backup_db.py --prune-only --dry-run

Settings (environment, or backend/.env for DATABASE_URL):
    DATABASE_URL        mysql+pymysql://user:pass@host:port/dbname  (database name taken from here)
    MYSQLDUMP_PATH      path to mysqldump (default: on PATH, else D:\\xxmp\\mysql\\bin\\mysqldump.exe)
    BACKUP_DIR          output folder (default: backend/var/backups)
    BACKUP_KEEP_DAILY   newest backup of each of the last N days to keep (default 7)
    BACKUP_KEEP_WEEKLY  newest backup of each of the last N ISO weeks to keep (default 4)

Output: <BACKUP_DIR>/signalcraft_YYYYmmdd_HHMM.sql.gz. The dump has no CREATE DATABASE/USE statements, so
scripts/restore_db.py can load it into any (new) database name.
"""
import argparse
import gzip
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
DEFAULT_BACKUP_DIR = BACKEND_DIR / "var" / "backups"
XAMPP_BIN = Path(r"D:\xxmp\mysql\bin")
PREFIX = "signalcraft"
NAME_RE = re.compile(rf"^{PREFIX}_(\d{{8}}_\d{{4}})\.sql\.gz$")


# ---------------------------------------------------------------- configuration

def _dotenv_value(key: str) -> str | None:
    env_file = BACKEND_DIR / ".env"
    if not env_file.exists():
        return None
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def setting(key: str, default: str | None = None) -> str | None:
    return os.environ.get(key) or _dotenv_value(key) or default


def db_params(url: str | None = None) -> dict:
    """Connection parameters from a SQLAlchemy-style DATABASE_URL."""
    from sqlalchemy.engine import make_url

    u = make_url(url or setting("DATABASE_URL") or "")
    if not u.database:
        raise SystemExit("DATABASE_URL must name a database")
    return {"host": u.host or "127.0.0.1", "port": u.port or 3306, "user": u.username or "root",
            "password": u.password or "", "database": u.database}


def find_tool(name: str, env_key: str) -> str:
    """A MySQL client tool: explicit env path, else PATH, else the XAMPP install."""
    explicit = os.environ.get(env_key)
    if explicit:
        if not Path(explicit).exists():
            raise SystemExit(f"{env_key}={explicit} does not exist")
        return explicit
    found = shutil.which(name)
    if found:
        return found
    for candidate in (XAMPP_BIN / f"{name}.exe", XAMPP_BIN / name):
        if candidate.exists():
            return str(candidate)
    raise SystemExit(f"{name} not found: set {env_key}")


def backup_dir() -> Path:
    return Path(setting("BACKUP_DIR") or DEFAULT_BACKUP_DIR)


def client_env(params: dict) -> dict:
    """Pass the password through MYSQL_PWD so it never appears in the process list."""
    env = dict(os.environ)
    if params["password"]:
        env["MYSQL_PWD"] = params["password"]
    return env


def conn_args(params: dict) -> list[str]:
    return [f"--host={params['host']}", f"--port={params['port']}", f"--user={params['user']}"]


# ---------------------------------------------------------------- retention

def parse_stamp(name: str) -> datetime | None:
    m = NAME_RE.match(name)
    return datetime.strptime(m.group(1), "%Y%m%d_%H%M") if m else None


def select_to_keep(names: list[str], keep_daily: int, keep_weekly: int) -> set[str]:
    """Grandfather-father retention: the newest backup of each of the last `keep_daily` days that have one,
    plus the newest of each of the last `keep_weekly` ISO weeks. The newest backup is always kept.
    Names that don't match the backup pattern are never selected for deletion by the caller."""
    dated = sorted(((parse_stamp(n), n) for n in names if parse_stamp(n)), reverse=True)
    if not dated:
        return set()
    keep = {dated[0][1]}
    days, weeks = {}, {}
    for stamp, name in dated:  # newest first, so the first one seen per bucket is that bucket's newest
        days.setdefault(stamp.date(), name)
        weeks.setdefault(stamp.isocalendar()[:2], name)
    keep.update(list(days.values())[:max(keep_daily, 0)])
    keep.update(list(weeks.values())[:max(keep_weekly, 0)])
    return keep


def prune(folder: Path, keep_daily: int, keep_weekly: int, dry_run: bool = False) -> list[Path]:
    names = [p.name for p in folder.glob(f"{PREFIX}_*.sql.gz")]
    keep = select_to_keep(names, keep_daily, keep_weekly)
    removed = []
    for name in sorted(names):
        if parse_stamp(name) and name not in keep:
            path = folder / name
            if not dry_run:
                path.unlink()
            removed.append(path)
    return removed


def newest_backup(folder: Path | None = None) -> Path | None:
    folder = folder or backup_dir()
    if not folder.exists():
        return None
    files = [p for p in folder.glob(f"{PREFIX}_*.sql.gz") if parse_stamp(p.name)]
    return max(files, key=lambda p: (parse_stamp(p.name), p.stat().st_mtime)) if files else None


# ---------------------------------------------------------------- dump

def dump(params: dict, folder: Path, now: datetime | None = None) -> Path:
    """Stream mysqldump into a gzip file. Written to a .partial file and renamed only on success."""
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{PREFIX}_{(now or datetime.now()):%Y%m%d_%H%M}.sql.gz"
    partial = target.with_name(target.name + ".partial")
    cmd = [find_tool("mysqldump", "MYSQLDUMP_PATH"), *conn_args(params), "--single-transaction", "--routines",
           "--triggers", "--default-character-set=utf8mb4", "--hex-blob", params["database"]]
    # Argument list, no shell; the database name comes from our own DATABASE_URL.
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=client_env(params))  # noqa: S603
    try:
        with gzip.open(partial, "wb", compresslevel=6) as out:
            for chunk in iter(lambda: proc.stdout.read(1 << 20), b""):
                out.write(chunk)
        stderr = proc.stderr.read().decode(errors="replace")
        code = proc.wait()
    except BaseException:
        proc.kill()
        partial.unlink(missing_ok=True)
        raise
    if code != 0:
        partial.unlink(missing_ok=True)
        raise SystemExit(f"mysqldump failed (exit {code}): {stderr.strip()[:500]}")
    os.replace(partial, target)
    return target


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Back up the database and prune old backups.")
    ap.add_argument("--output-dir", type=Path, default=None, help="default: BACKUP_DIR or backend/var/backups")
    ap.add_argument("--keep-daily", type=int, default=int(setting("BACKUP_KEEP_DAILY", "7")))
    ap.add_argument("--keep-weekly", type=int, default=int(setting("BACKUP_KEEP_WEEKLY", "4")))
    ap.add_argument("--no-prune", action="store_true", help="keep every backup")
    ap.add_argument("--prune-only", action="store_true", help="don't dump, only apply retention")
    ap.add_argument("--dry-run", action="store_true", help="with pruning: list what would be deleted")
    args = ap.parse_args(argv)
    folder = args.output_dir or backup_dir()
    if not args.prune_only:
        params = db_params()
        path = dump(params, folder)
        print(f"backup written: {path} ({path.stat().st_size:,} bytes) from database {params['database']}")
    if not args.no_prune:
        removed = prune(folder, args.keep_daily, args.keep_weekly, dry_run=args.dry_run)
        verb = "would delete" if args.dry_run else "deleted"
        for p in removed:
            print(f"{verb}: {p.name}")
        print(f"retention: keep {args.keep_daily} daily + {args.keep_weekly} weekly; {verb} {len(removed)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
