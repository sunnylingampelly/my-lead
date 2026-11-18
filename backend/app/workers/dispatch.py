"""Hand work to the background.

* Normal operation: Celery (Redis broker), executed by the worker service.
* Docker-less development (CELERY_TASK_ALWAYS_EAGER=true): a small thread pool, so long jobs
  such as imports still run outside the HTTP request.
* Tests: synchronous, so assertions see the finished result.
"""
import threading

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)
# At most two local jobs at once. Threads are daemons so a dev-server reload is never blocked;
# an interrupted job rolls back its open chunk and is resumed on the next startup.
_slots = threading.BoundedSemaphore(2)


def _run_local(task, args, kwargs):
    with _slots:
        try:
            task.apply(args=args, kwargs=kwargs, throw=False)
        except Exception:
            log.exception("background_task_failed", task=task.name)


def dispatch(task, *args, **kwargs) -> None:
    if not settings.CELERY_TASK_ALWAYS_EAGER:
        task.apply_async(args=args, kwargs=kwargs)
    elif settings.ENVIRONMENT == "test":
        # Synchronous, but like a real queue a task failure does not fail the caller.
        task.apply(args=args, kwargs=kwargs, throw=False)
    else:
        threading.Thread(target=_run_local, args=(task, args, kwargs), daemon=True, name=f"bg-{task.name}").start()
