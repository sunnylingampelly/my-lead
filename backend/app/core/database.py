"""Database engine and session management."""
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings


def build_engine(url: str | None = None) -> Engine:
    url = url or settings.DATABASE_URL
    kwargs: dict = {"echo": settings.DATABASE_ECHO}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
    else:
        kwargs.update(pool_pre_ping=True, pool_size=10, max_overflow=20, pool_recycle=1800)
    eng = create_engine(url, **kwargs)
    if url.startswith("sqlite"):

        @event.listens_for(eng, "connect")
        def _fk_on(dbapi_conn, _):  # enforce foreign keys on SQLite as MySQL does
            # Let SQLAlchemy own transactions so SAVEPOINTs work (pysqlite workaround).
            dbapi_conn.isolation_level = None
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA busy_timeout=10000")  # background import thread + API requests
            if ":memory:" not in url:
                cur.execute("PRAGMA journal_mode=WAL")
            cur.close()

        @event.listens_for(eng, "begin")
        def _begin(conn):
            # IMMEDIATE takes the write lock up front, so concurrent writers (API requests and the
            # background import thread) wait on busy_timeout instead of failing with "database is
            # locked" when a read transaction tries to upgrade. SQLite is a development fallback only.
            conn.exec_driver_sql("BEGIN IMMEDIATE")

    return eng


engine = build_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    """Transactional scope for background tasks."""
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
