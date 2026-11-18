"""File storage abstraction: local disk for development, S3-compatible object storage otherwise.
Keys are always generated server-side; user-supplied file names are never used as paths."""
import uuid
from abc import ABC, abstractmethod
from pathlib import Path

from app.core.config import settings


class Storage(ABC):
    @abstractmethod
    def put(self, key: str, data: bytes, content_type: str) -> str: ...

    @abstractmethod
    def get(self, key: str) -> bytes: ...

    @abstractmethod
    def delete(self, key: str) -> None: ...


def build_key(organization_id: str, application_id: str, area: str, extension: str) -> str:
    ext = "".join(c for c in extension.lower() if c.isalnum())[:8]
    return f"{organization_id}/{application_id}/{area}/{uuid.uuid4()}.{ext or 'bin'}"


class LocalStorage(Storage):
    def __init__(self, root: str | None = None):
        self.root = Path(root or settings.LOCAL_STORAGE_PATH).resolve()

    def _path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root not in p.parents:
            raise ValueError("Invalid storage key")
        return p

    def put(self, key: str, data: bytes, content_type: str) -> str:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        return key

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)


class S3Storage(Storage):
    def __init__(self):
        import boto3

        self.bucket = settings.S3_BUCKET
        self.client = boto3.client("s3", endpoint_url=settings.S3_ENDPOINT_URL, region_name=settings.AWS_REGION,
                                   aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
                                   aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY)

    def put(self, key: str, data: bytes, content_type: str) -> str:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type,
                               ServerSideEncryption="AES256")
        return key

    def get(self, key: str) -> bytes:
        return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)


def get_storage() -> Storage:
    return S3Storage() if settings.STORAGE_BACKEND == "s3" else LocalStorage()
