"""Shared voice test helpers: load numbers into the platform pool, as a platform admin would."""
from app.core.database import SessionLocal
from app.models.voice import PhoneNumber


def add_pool_number(number: str, country: str, kind: str, provider: str = "simulation") -> str:
    """Load one number into the platform pool. Calls pick their caller from the pool automatically."""
    with SessionLocal() as db:
        pn = PhoneNumber(number=number, country=country, kind=kind, provider=provider, status="available",
                         included=False)
        db.add(pn)
        db.commit()
        return pn.id
