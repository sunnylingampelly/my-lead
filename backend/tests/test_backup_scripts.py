"""Backup retention logic and restore safety checks (the real dump/restore is verified manually, see
docs/operations.md)."""
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import backup_db  # noqa: E402
import restore_db  # noqa: E402


def names(start: datetime, hours: int, every_hours: int = 6) -> list[str]:
    return [f"signalcraft_{start - timedelta(hours=h):%Y%m%d_%H%M}.sql.gz" for h in range(0, hours, every_hours)]


def test_keeps_newest_per_day_and_per_week():
    start = datetime(2026, 11, 24, 3, 0)  # a Tuesday
    files = names(start, 24 * 60)  # four backups a day for 60 days
    keep = backup_db.select_to_keep(files, keep_daily=7, keep_weekly=4)
    stamps = sorted(backup_db.parse_stamp(n) for n in keep)
    assert files[0] in keep  # the newest
    days = {s.date() for s in stamps}
    # 7 most recent days, each represented by its newest backup...
    for d in range(7):
        day = (start - timedelta(days=d)).date()
        assert day in days
        assert max(backup_db.parse_stamp(n) for n in files if backup_db.parse_stamp(n).date() == day) in stamps
    # ...plus the newest backup of each of the last 4 ISO weeks (some coincide with daily ones).
    weeks = {s.isocalendar()[:2] for s in stamps}
    assert len(weeks) == 4
    assert len(keep) <= 7 + 4


def test_retention_edge_cases():
    assert backup_db.select_to_keep([], 7, 4) == set()
    one = ["signalcraft_20261124_0300.sql.gz"]
    assert backup_db.select_to_keep(one, 0, 0) == set(one)  # never delete the only/newest backup
    assert backup_db.parse_stamp("other_20261124_0300.sql.gz") is None
    assert backup_db.parse_stamp("signalcraft_20261124_0300.sql") is None


def test_prune_only_touches_backup_files(tmp_path):
    start = datetime(2026, 11, 24, 3, 0)
    for n in names(start, 24 * 20, 24):
        (tmp_path / n).write_bytes(b"x")
    (tmp_path / "notes.txt").write_text("keep me")
    (tmp_path / "signalcraft_manual.sql.gz").write_bytes(b"x")
    dry = backup_db.prune(tmp_path, keep_daily=3, keep_weekly=2, dry_run=True)
    assert dry and all(p.exists() for p in dry)
    removed = backup_db.prune(tmp_path, keep_daily=3, keep_weekly=2)
    assert {p.name for p in removed} == {p.name for p in dry}
    left = {p.name for p in tmp_path.iterdir()}
    assert "notes.txt" in left and "signalcraft_manual.sql.gz" in left
    assert len([n for n in left if backup_db.parse_stamp(n)]) <= 5
    assert backup_db.newest_backup(tmp_path).name == names(start, 1)[0]


def test_admin_settings_show_last_backup(tmp_path, monkeypatch):
    from app.cli import main as cli
    from app.core.config import settings
    from tests.conftest import Api

    a = Api().register("root@example.com", "Platform Root")
    assert cli(["grant-admin", "root@example.com"]) == 0
    a = Api().login("root@example.com")
    monkeypatch.setattr(settings, "BACKUP_DIR", str(tmp_path))
    b = a.get("/admin/settings").json()["backups"]
    assert b["last_backup_at"] is None and b["stale"] is True and b["count"] == 0
    (tmp_path / "signalcraft_20261124_0300.sql.gz").write_bytes(b"x" * 10)
    b = a.get("/admin/settings").json()["backups"]
    assert b["count"] == 1 and b["last_backup_file"] == "signalcraft_20261124_0300.sql.gz"
    assert b["last_backup_at"] and b["stale"] is False and str(tmp_path) not in str(b)


def test_db_params_and_restore_guards():
    p = backup_db.db_params("mysql+pymysql://root:@127.0.0.1:3306/signalcraft_dev?charset=utf8mb4")
    assert p == {"host": "127.0.0.1", "port": 3306, "user": "root", "password": "", "database": "signalcraft_dev"}
    for bad in ("live", "mysql", "bad-name;drop", "x" * 65):
        with pytest.raises(SystemExit):
            restore_db.check_target(bad, "signalcraft_dev", force=True)
    with pytest.raises(SystemExit):
        restore_db.check_target("signalcraft_dev", "signalcraft_dev", force=False)
    restore_db.check_target("signalcraft_restore_check", "signalcraft_dev", force=False)
