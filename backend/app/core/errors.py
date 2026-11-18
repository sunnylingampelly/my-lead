"""Domain errors and a consistent JSON error envelope.

Every error response has the shape:
    {"error": {"code": "STRING_CODE", "message": "...", "details": ... | null, "request_id": "..."}}
"""
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.logging import get_logger

log = get_logger(__name__)


class AppError(Exception):
    status_code = 400
    code = "BAD_REQUEST"

    def __init__(self, message: str | None = None, *, code: str | None = None, details: Any = None):
        super().__init__(message or self.code)
        if code:
            self.code = code
        self.message = message or self.code.replace("_", " ").capitalize()
        self.details = details


class ValidationFailed(AppError):
    status_code = 422
    code = "VALIDATION_ERROR"


class Unauthorized(AppError):
    status_code = 401
    code = "UNAUTHORIZED"


class Forbidden(AppError):
    status_code = 403
    code = "FORBIDDEN"


class NotFound(AppError):
    status_code = 404
    code = "NOT_FOUND"


class Conflict(AppError):
    status_code = 409
    code = "CONFLICT"


class RateLimited(AppError):
    status_code = 429
    code = "RATE_LIMITED"


def _body(request: Request, code: str, message: str, details: Any = None) -> dict:
    return {
        "error": {
            "code": code,
            "message": message,
            "details": details,
            "request_id": getattr(request.state, "request_id", None),
        }
    }


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError):
        return JSONResponse(status_code=exc.status_code, content=_body(request, exc.code, exc.message, exc.details))

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError):
        details = [
            {"loc": [str(p) for p in e.get("loc", [])], "msg": e.get("msg"), "type": e.get("type")}
            for e in exc.errors()
        ]
        return JSONResponse(status_code=422, content=_body(request, "VALIDATION_ERROR", "Invalid request", details))

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException):
        code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED", 401: "UNAUTHORIZED", 403: "FORBIDDEN"}.get(
            exc.status_code, "HTTP_ERROR"
        )
        return JSONResponse(status_code=exc.status_code, content=_body(request, code, str(exc.detail)))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):
        log.exception("unhandled_error", path=request.url.path)
        return JSONResponse(status_code=500, content=_body(request, "INTERNAL_ERROR", "An unexpected error occurred"))
