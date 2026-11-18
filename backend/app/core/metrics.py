"""Small Prometheus-style metrics: in-process request counters plus gauges read from the database
when /metrics is scraped. Each API process keeps its own counters (scrape every instance)."""
import threading
from collections import Counter

_lock = threading.Lock()
_requests: Counter = Counter()
_latency_ms: Counter = Counter()


def observe(method: str, path_group: str, status: int, duration_ms: float) -> None:
    key = (method, path_group, f"{status // 100}xx")
    with _lock:
        _requests[key] += 1
        _latency_ms[key] += duration_ms


def path_group(path: str) -> str:
    """Collapse ids so label cardinality stays small: /api/v1/apps/{id}/email/campaigns → apps/email."""
    parts = [p for p in path.split("/") if p][2:]  # drop "api", "v1"
    keep = [p for p in parts if not (len(p) >= 20 or p.isdigit() or "." in p)]
    return "/".join(keep[:3]) or "root"


def render(gauges: dict[str, list[tuple[dict, float]]]) -> str:
    lines = ["# TYPE signalcraft_http_requests_total counter"]
    with _lock:
        for (m, g, s), n in sorted(_requests.items()):
            lines.append(f'signalcraft_http_requests_total{{method="{m}",path="{g}",status="{s}"}} {n}')
        lines.append("# TYPE signalcraft_http_request_duration_ms_sum counter")
        for (m, g, s), v in sorted(_latency_ms.items()):
            lines.append(f'signalcraft_http_request_duration_ms_sum{{method="{m}",path="{g}",status="{s}"}} {v:.1f}')
    for name, samples in gauges.items():
        lines.append(f"# TYPE {name} gauge")
        for labels, value in samples:
            lab = ",".join(f'{k}="{v}"' for k, v in labels.items())
            lines.append(f"{name}{{{lab}}} {value}" if lab else f"{name} {value}")
    return "\n".join(lines) + "\n"
