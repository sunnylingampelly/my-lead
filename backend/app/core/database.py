"""Database engine and session management."""
from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings


def build_engine(url: str | None = None) -> Engine:
    url = url or settings.DATABASE_URL
    if not url.startswith("mysql"):
        raise RuntimeError("DATABASE_URL must be a MySQL URL (mysql+pymysql://...); SQLite is not supported")
    return create_engine(url, echo=settings.DATABASE_ECHO, pool_pre_ping=True, pool_size=10,
                         max_overflow=20, pool_recycle=1800)


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
