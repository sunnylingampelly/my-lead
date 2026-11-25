"""Fetching web pages and reading files to train chatbots.

Everything a customer points us at is untrusted, so fetching is locked down (SSRF):
* http(s) only, default ports or 80/443/8080/8443, no credentials in the URL;
* the host is resolved once and every address must be public (no private, loopback, link-local, multicast,
  reserved or carrier-grade NAT ranges); the connection is then pinned to that address (TLS still verifies
  the real hostname), so a second DNS answer can't redirect us inside the network;
* at most MAX_REDIRECTS redirects, each re-checked; timeouts; a byte cap while streaming;
* a User-Agent naming Signalcraft, and robots.txt is respected when crawling a site.
"""
import io
import ipaddress
import re
import socket
import zipfile
from dataclasses import dataclass, field
from html import unescape
from html.parser import HTMLParser
from urllib.parse import urldefrag, urljoin, urlparse, urlunparse
from urllib.robotparser import RobotFileParser
from xml.etree import ElementTree

import httpx

from app.core.config import settings
from app.core.logging import get_logger

log = get_logger(__name__)

MAX_REDIRECTS = 3
TIMEOUT = httpx.Timeout(10.0, connect=5.0)
ALLOWED_PORTS = {None, 80, 443, 8080, 8443}
PAGE_TEXT_CAP = 120_000  # characters kept from one page
SOURCE_TEXT_CAP = 600_000  # characters kept from one source (a crawl of many pages, a long PDF)
USER_AGENT = f"{settings.APP_NAME}Bot/1.0 (website chatbot training; +{settings.FRONTEND_URL.rstrip('/')})"
# Tests replace this with httpx.MockTransport.
transport: httpx.BaseTransport | None = None


class FetchError(Exception):
    """A URL we refuse to fetch or couldn't read. The message is safe to show to the user."""


# ------------------------------------------------------------------ address safety

_CGNAT = ipaddress.ip_network("100.64.0.0/10")


def ip_is_public(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip.split("%")[0])
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    if addr.version == 4 and addr in _CGNAT:
        return False
    return addr.is_global and not (addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_multicast
                                   or addr.is_reserved or addr.is_unspecified)


def _resolve(host: str) -> list[str]:
    infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(i[4][0] for i in infos))


def check_url(url: str) -> tuple[str, str]:
    """Validate a URL's shape and resolve it to a public address. Returns (normalised url, ip)."""
    url = (url or "").strip()
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url if url and "://" not in url else url
    try:
        p = urlparse(url)
    except ValueError as exc:
        raise FetchError("That doesn't look like a web address") from exc
    if p.scheme.lower() not in ("http", "https") or not p.hostname:
        raise FetchError("Only http:// and https:// web addresses can be used")
    if p.username or p.password:
        raise FetchError("Web addresses with a username or password can't be used")
    try:
        port = p.port
    except ValueError as exc:
        raise FetchError("That web address has an invalid port") from exc
    if port not in ALLOWED_PORTS:
        raise FetchError("Only standard web ports (80, 443, 8080, 8443) can be used")
    host = p.hostname.lower().rstrip(".")
    if host in ("localhost",) or host.endswith((".localhost", ".local", ".internal")):
        raise FetchError("That address points to a private network and can't be fetched")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        ips = [str(literal)]
    else:
        try:
            ips = _resolve(host)
        except (socket.gaierror, UnicodeError, OSError) as exc:
            raise FetchError(f"Couldn't find the website {host}") from exc
    if not ips or not all(ip_is_public(ip) for ip in ips):
        raise FetchError("That address points to a private network and can't be fetched")
    clean = urlunparse((p.scheme.lower(), p.netloc.lower(), p.path or "/", "", p.query, ""))
    return clean, ips[0]


# ------------------------------------------------------------------ fetching


@dataclass
class Fetched:
    url: str
    status: int
    content_type: str
    body: bytes
    truncated: bool = False


def _pinned(url: str, ip: str) -> tuple[str, dict, dict]:
    p = urlparse(url)
    host = p.hostname or ""
    ip_host = f"[{ip}]" if ":" in ip else ip
    netloc = ip_host + (f":{p.port}" if p.port else "")
    target = urlunparse((p.scheme, netloc, p.path or "/", "", p.query, ""))
    headers = {"Host": p.netloc, "User-Agent": USER_AGENT,
               "Accept": "text/html,application/xhtml+xml,text/plain,application/xml;q=0.9,*/*;q=0.5",
               "Accept-Language": "en;q=0.9,*;q=0.5"}
    ext = {"sni_hostname": host} if p.scheme == "https" else {}
    return target, headers, ext


def fetch(url: str, max_bytes: int | None = None) -> Fetched:
    """GET a public URL safely, following up to MAX_REDIRECTS redirects."""
    cap = max_bytes or settings.CHAT_FETCH_MAX_BYTES
    current = url
    with httpx.Client(timeout=TIMEOUT, follow_redirects=False, transport=transport, verify=True) as client:
        for _ in range(MAX_REDIRECTS + 1):
            clean, ip = check_url(current)
            target, headers, ext = _pinned(clean, ip)
            try:
                req = client.build_request("GET", target, headers=headers, extensions=ext)
                resp = client.send(req, stream=True)
            except httpx.TimeoutException as exc:
                raise FetchError("The website took too long to respond") from exc
            except httpx.HTTPError as exc:
                raise FetchError("Couldn't connect to the website") from exc
            try:
                if resp.status_code in (301, 302, 303, 307, 308) and resp.headers.get("location"):
                    current = urljoin(clean, resp.headers["location"])
                    continue
                chunks, size, truncated = [], 0, False
                for chunk in resp.iter_bytes():
                    chunks.append(chunk)
                    size += len(chunk)
                    if size > cap:
                        truncated = True
                        break
                body = b"".join(chunks)[:cap]
                return Fetched(url=clean, status=resp.status_code,
                               content_type=(resp.headers.get("content-type") or "").split(";")[0].strip().lower(),
                               body=body, truncated=truncated)
            except httpx.HTTPError as exc:
                raise FetchError("The website stopped responding while we were reading it") from exc
            finally:
                resp.close()
    raise FetchError("The website redirected too many times")


def _decode(body: bytes, content_type: str = "") -> str:
    m = re.search(rb'<meta[^>]+charset=["\']?([A-Za-z0-9_-]+)', body[:4096], re.I)
    for enc in ([m.group(1).decode("ascii", "ignore")] if m else []) + ["utf-8", "cp1252", "latin-1"]:
        try:
            return body.decode(enc)
        except (LookupError, UnicodeDecodeError):
            continue
    return body.decode("utf-8", "replace")


# ------------------------------------------------------------------ HTML → text

SKIP_TAGS = {"script", "style", "noscript", "nav", "footer", "header", "svg", "form", "iframe", "template",
             "button", "select", "canvas", "aside", "object", "embed"}
BLOCK_TAGS = {"p", "div", "section", "article", "main", "li", "ul", "ol", "br", "tr", "table", "h1", "h2", "h3",
              "h4", "h5", "h6", "blockquote", "pre", "dd", "dt", "dl", "hr", "td", "th", "figcaption"}
VOID = {"br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"}


class _Extractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0
        self.stack: list[tuple[str, bool]] = []
        self.title = ""
        self.in_title = False
        self.description = ""
        self.links: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "a" and a.get("href"):
            self.links.append(a["href"])
        if tag == "meta" and (a.get("name") or "").lower() == "description":
            self.description = (a.get("content") or "")[:500]
        if tag == "title":
            self.in_title = True
        if tag in VOID:
            if tag in BLOCK_TAGS:
                self.parts.append("\n")
            return
        skipped = tag in SKIP_TAGS or (a.get("role") or "") in ("navigation", "banner", "contentinfo") \
            or a.get("aria-hidden") == "true"
        self.stack.append((tag, skipped))
        if skipped:
            self.skip += 1
        if tag in BLOCK_TAGS:
            self.parts.append("\n")
        if tag in ("h1", "h2", "h3") and not self.skip:
            self.parts.append("## " if tag != "h1" else "# ")
        if tag == "li" and not self.skip:
            self.parts.append("- ")

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag in VOID:
            return
        if not any(t == tag for t, _ in self.stack):
            return  # stray end tag
        while self.stack:
            t, skipped = self.stack.pop()
            if skipped:
                self.skip -= 1
            if t == tag:
                break
        if tag in BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if self.in_title:
            self.title += data
            return
        if not self.skip:
            self.parts.append(data)


def html_to_text(html: str) -> tuple[str, str, list[str]]:
    """(title, readable text, raw links). Drops navigation, headers, footers, scripts, styles and forms."""
    p = _Extractor()
    try:
        p.feed(html)
        p.close()
    except Exception:  # noqa: BLE001, S110 - malformed markup: keep what was parsed
        pass
    text = "".join(p.parts)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    lines = [ln.strip() for ln in text.split("\n")]
    out: list[str] = []
    for ln in lines:
        if not ln or ln in ("-", "#", "##"):
            if out and out[-1] != "":
                out.append("")
            continue
        out.append(ln)
    body = "\n".join(out).strip()
    if p.description and p.description not in body[:2000]:
        body = (p.description.strip() + "\n\n" + body).strip()
    return re.sub(r"\s+", " ", unescape(p.title)).strip()[:300], body[:PAGE_TEXT_CAP], p.links


# ------------------------------------------------------------------ one page / a crawl


@dataclass
class PageText:
    url: str
    title: str
    text: str


@dataclass
class CrawlResult:
    pages: list[PageText] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)


def read_page(url: str) -> tuple[PageText, list[str]]:
    f = fetch(url)
    if f.status >= 400:
        raise FetchError(f"The website answered with an error ({f.status})")
    ctype = f.content_type
    if ctype in ("text/plain", "text/markdown"):
        return PageText(f.url, urlparse(f.url).path or f.url, _decode(f.body)[:PAGE_TEXT_CAP]), []
    if ctype == "application/pdf":
        return PageText(f.url, urlparse(f.url).path.rsplit("/", 1)[-1] or f.url, pdf_text(f.body)), []
    if ctype and "html" not in ctype and "xml" not in ctype:
        raise FetchError(f"That page isn't a web page or text ({ctype})")
    title, text, links = html_to_text(_decode(f.body, ctype))
    return PageText(f.url, title or f.url, text), [urljoin(f.url, h) for h in links]


def _same_site(a: str, b: str) -> bool:
    ha, hb = (urlparse(a).hostname or "").lower(), (urlparse(b).hostname or "").lower()
    return ha.removeprefix("www.") == hb.removeprefix("www.")


def _robots(start: str) -> tuple[RobotFileParser | None, list[str]]:
    p = urlparse(start)
    robots_url = f"{p.scheme}://{p.netloc}/robots.txt"
    rp = RobotFileParser()
    try:
        f = fetch(robots_url, max_bytes=200_000)
    except FetchError:
        return None, []
    if f.status >= 400:
        return None, []
    lines = _decode(f.body).splitlines()
    rp.parse(lines)
    sitemaps = [ln.split(":", 1)[1].strip() for ln in lines if ln.lower().startswith("sitemap:")]
    return rp, sitemaps


def _sitemap_urls(url: str, depth: int = 0, limit: int = 500) -> list[str]:
    try:
        f = fetch(url, max_bytes=5_000_000)
    except FetchError:
        return []
    if f.status >= 400:
        return []
    try:
        root = ElementTree.fromstring(f.body)  # noqa: S314 - stdlib parser; no external entities are resolved
    except ElementTree.ParseError:
        return []
    locs = [el.text.strip() for el in root.iter() if el.tag.endswith("loc") and el.text]
    if root.tag.endswith("sitemapindex") and depth == 0:
        out: list[str] = []
        for loc in locs[:5]:
            out += _sitemap_urls(loc, depth + 1, limit)
            if len(out) >= limit:
                break
        return out[:limit]
    return locs[:limit]


def crawl(start: str, max_pages: int) -> CrawlResult:
    """The start page plus same-site pages from the sitemap (or links when there is none), honouring robots.txt."""
    max_pages = max(1, min(max_pages, settings.CHAT_CRAWL_MAX_PAGES))
    start, _ = check_url(start)
    rp, sitemaps = _robots(start)

    def allowed(u: str) -> bool:
        return rp is None or (rp.can_fetch(USER_AGENT, u) and rp.can_fetch("*", u))

    result = CrawlResult()
    if not allowed(start):
        raise FetchError("The website's robots.txt doesn't allow fetching this page")
    first, links = read_page(start)
    result.pages.append(first)
    seen = {urldefrag(start)[0].rstrip("/"), urldefrag(first.url)[0].rstrip("/")}
    queue: list[str] = []
    p = urlparse(start)
    for sm in sitemaps or [f"{p.scheme}://{p.netloc}/sitemap.xml"]:
        queue += [u for u in _sitemap_urls(sm) if _same_site(u, start)]
        if queue:
            break
    if not queue:
        queue = links
    total = len(first.text)
    for u in queue:
        if len(result.pages) >= max_pages or total >= SOURCE_TEXT_CAP:
            break
        u = urldefrag(u)[0]
        key = u.rstrip("/")
        if key in seen or not u.startswith(("http://", "https://")) or not _same_site(u, start):
            continue
        if re.search(r"\.(png|jpe?g|gif|svg|webp|zip|mp4|mp3|css|js|ico|woff2?)(\?|$)", u, re.I):
            continue
        seen.add(key)
        if not allowed(u):
            result.skipped.append({"url": u, "reason": "robots.txt"})
            continue
        try:
            page, _ = read_page(u)
        except FetchError as exc:
            result.skipped.append({"url": u, "reason": str(exc)})
            continue
        if page.text.strip():
            result.pages.append(page)
            total += len(page.text)
    return result


def pages_to_content(pages: list[PageText]) -> str:
    out = "\n\n".join(f"## {p.title}\nPage: {p.url}\n{p.text.strip()}" for p in pages if p.text.strip())
    return out[:SOURCE_TEXT_CAP]


# ------------------------------------------------------------------ files

FILE_TYPES = {".txt": "text", ".md": "text", ".markdown": "text", ".csv": "text", ".pdf": "pdf", ".docx": "docx",
              ".html": "html", ".htm": "html"}


def pdf_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover - pypdf is in requirements.txt
        raise FetchError("PDF support isn't installed on this server") from exc
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception as exc:  # noqa: BLE001
                raise FetchError("That PDF is password-protected") from exc
        parts, total = [], 0
        for page in reader.pages[:500]:
            t = page.extract_text() or ""
            parts.append(t)
            total += len(t)
            if total > SOURCE_TEXT_CAP:
                break
    except FetchError:
        raise
    except Exception as exc:  # noqa: BLE001 - malformed PDFs raise many different errors
        raise FetchError("Couldn't read text from that PDF") from exc
    text = re.sub(r"[ \t]+", " ", "\n".join(parts))
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        raise FetchError("That PDF has no selectable text (it may be scanned images)")
    return text[:SOURCE_TEXT_CAP]


def docx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            info = z.getinfo("word/document.xml")
            if info.file_size > 50_000_000:
                raise FetchError("That document is too large")
            xml = z.read(info)
    except (KeyError, zipfile.BadZipFile) as exc:
        raise FetchError("That isn't a valid .docx file") from exc
    xml_s = xml.decode("utf-8", "replace")
    xml_s = re.sub(r"<w:tab[^>]*/>", "\t", xml_s)
    xml_s = re.sub(r"<w:br[^>]*/>", "\n", xml_s)
    xml_s = re.sub(r"</w:p>", "\n", xml_s)
    text = unescape(re.sub(r"<[^>]+>", "", xml_s))
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:SOURCE_TEXT_CAP]


def file_text(filename: str, data: bytes) -> str:
    ext = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    kind = FILE_TYPES.get(ext)
    if kind is None:
        raise FetchError("Upload a .txt, .md, .csv, .pdf, .docx or .html file")
    if kind == "pdf":
        return pdf_text(data)
    if kind == "docx":
        return docx_text(data)
    if kind == "html":
        return html_to_text(_decode(data))[1][:SOURCE_TEXT_CAP]
    text = _decode(data).replace("\r\n", "\n").replace("\x00", "")
    if not text.strip():
        raise FetchError("That file is empty")
    return text[:SOURCE_TEXT_CAP]
