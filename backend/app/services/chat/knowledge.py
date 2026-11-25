"""Chatbot training: knowledge sources (text, FAQ pairs, web pages, files), chunking and retrieval.

Retrieval design
* Small knowledge (up to CHAT_KNOWLEDGE_INLINE_CHARS, ~150k characters) goes whole into the cached part of
  the system prompt: best answers, and prompt caching keeps repeat questions cheap.
* Larger knowledge: FAQ pairs stay in the prompt (they are short and high value); everything else is split
  into ~1,500-character overlapping chunks (chat_knowledge_chunks) and the best chunks for each question
  are found with MariaDB FULLTEXT (MATCH ... AGAINST in natural language mode), with a keyword (LIKE)
  fallback, and placed after the cached block.
"""
import re
from collections import Counter

from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.errors import NotFound, ValidationFailed
from app.core.logging import get_logger
from app.models.chat import ChatBot, ChatKnowledgeChunk, ChatKnowledgeSource, ChatMessage
from app.schemas.chat import ImproveAnswer, SourceCreate, SourceUpdate
from app.services.chat import fetch
from app.utils.time import utcnow

log = get_logger(__name__)
CHUNK_SIZE, CHUNK_OVERLAP = 1500, 200
FAQ_INLINE_CAP = 40_000
TOP_K = 6
STOPWORDS = set("""a an the and or but if then else of to in on at by for with about from into over after before
is are was were be been being am do does did have has had i you he she it we they me my your our their this that
these those what which who whom whose when where why how can could would should will shall may might must not no
yes please thanks thank hi hello hey there here any some much many more most very just also too so than as up out
get got tell know want need like""".split())
KIND_ORDER = {"faq": 0, "text": 1, "url": 2, "file": 3}


# ------------------------------------------------------------------ text helpers


def words(s: str) -> list[str]:
    return [w for w in re.findall(r"[^\W_]{2,}", (s or "").lower()) if w not in STOPWORDS]


def source_text(s: ChatKnowledgeSource) -> str:
    if s.kind == "faq":
        return f"Q: {(s.question or '').strip()}\nA: {(s.content or '').strip()}"
    return (s.content or "").strip()


def chunk_text(body: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Split on paragraph (then sentence) boundaries into pieces of about `size` characters, each starting with
    the last ~`overlap` characters of the previous piece so answers spanning a boundary aren't lost."""
    body = re.sub(r"\n{3,}", "\n\n", (body or "").strip())
    if not body:
        return []
    if len(body) <= size:
        return [body]
    paras: list[str] = []
    for p in body.split("\n\n"):
        if len(p) <= size:
            paras.append(p)
            continue
        sentences = re.split(r"(?<=[.!?])\s+", p)
        cur = ""
        for s in sentences:
            while len(s) > size:  # one enormous "sentence": hard split
                paras.append(s[:size])
                s = s[size:]
            if len(cur) + len(s) + 1 > size and cur:
                paras.append(cur)
                cur = ""
            cur = f"{cur} {s}".strip()
        if cur:
            paras.append(cur)
    chunks: list[str] = []
    cur = ""
    for p in paras:
        if cur and len(cur) + len(p) + 2 > size:
            chunks.append(cur)
            tail = cur[-overlap:]
            cut = tail.find(" ")
            cur = (tail[cut + 1:] if cut != -1 else tail) + "\n\n" + p
        else:
            cur = f"{cur}\n\n{p}" if cur else p
    if cur:
        chunks.append(cur)
    return chunks


# ------------------------------------------------------------------ lookups


def bot_row(db: Session, ctx, bot_id: str) -> ChatBot:
    b = db.scalar(select(ChatBot).where(ChatBot.id == bot_id, ChatBot.application_id == ctx.application_id))
    if b is None:
        raise NotFound("Chatbot not found")
    return b


def source_row(db: Session, bot: ChatBot, source_id: str) -> ChatKnowledgeSource:
    s = db.scalar(select(ChatKnowledgeSource).where(ChatKnowledgeSource.id == source_id,
                                                    ChatKnowledgeSource.bot_id == bot.id))
    if s is None:
        raise NotFound("Training source not found")
    return s


def sources(db: Session, bot_id: str, ready_only: bool = False) -> list[ChatKnowledgeSource]:
    q = select(ChatKnowledgeSource).where(ChatKnowledgeSource.bot_id == bot_id)
    if ready_only:
        q = q.where(ChatKnowledgeSource.status == "ready")
    rows = list(db.scalars(q.order_by(ChatKnowledgeSource.created_at)))
    return sorted(rows, key=lambda s: (KIND_ORDER.get(s.kind, 9), s.created_at))


def source_out(s: ChatKnowledgeSource, full: bool = False) -> dict:
    content = s.content or ""
    return {"id": s.id, "kind": s.kind, "title": s.title, "url": s.url, "question": s.question,
            "content": content if full or s.kind in ("faq", "text") else None,
            "preview": content[:400], "status": s.status, "error": s.error, "char_count": s.char_count,
            "last_synced_at": s.last_synced_at.isoformat() if s.last_synced_at else None,
            "meta": {k: v for k, v in (s.meta or {}).items() if k in ("pages", "skipped", "crawl", "max_pages",
                                                                         "filename", "from_message")},
            "created_at": s.created_at.isoformat()}


# ------------------------------------------------------------------ bookkeeping


def refresh_totals(db: Session, bot: ChatBot) -> None:
    db.flush()
    bot.knowledge_chars = int(db.scalar(select(func.coalesce(func.sum(ChatKnowledgeSource.char_count), 0)).where(
        ChatKnowledgeSource.bot_id == bot.id, ChatKnowledgeSource.status == "ready")) or 0)


def rechunk(db: Session, s: ChatKnowledgeSource) -> int:
    db.execute(delete(ChatKnowledgeChunk).where(ChatKnowledgeChunk.source_id == s.id))
    if s.status != "ready":
        return 0
    body = source_text(s)
    pieces = [body] if s.kind == "faq" else chunk_text(body)
    db.add_all([ChatKnowledgeChunk(bot_id=s.bot_id, source_id=s.id, position=i, title=(s.title or "")[:300],
                                   content=p) for i, p in enumerate(pieces)])
    return len(pieces)


def _set_content(db: Session, bot: ChatBot, s: ChatKnowledgeSource, content: str) -> None:
    s.content = content
    s.char_count = len(source_text(s))
    s.status, s.error, s.last_synced_at = "ready", None, utcnow()
    rechunk(db, s)
    refresh_totals(db, bot)


def _check_room(db: Session, bot: ChatBot, adding: int, replacing: int = 0) -> None:
    refresh_totals(db, bot)
    if bot.knowledge_chars - replacing + adding > settings.CHAT_KNOWLEDGE_MAX_CHARS:
        raise ValidationFailed(f"A chatbot can be trained on up to {settings.CHAT_KNOWLEDGE_MAX_CHARS:,} characters. "
                               "Remove some sources first.", code="KNOWLEDGE_FULL")


# ------------------------------------------------------------------ sources


def add_source(db: Session, ctx, bot: ChatBot, data: SourceCreate) -> ChatKnowledgeSource:
    s = ChatKnowledgeSource(organization_id=bot.organization_id, application_id=bot.application_id, bot_id=bot.id,
                            kind=data.kind, meta={}, created_by_id=ctx.user.id if ctx.user else None)
    if data.kind == "text":
        body = (data.content or "").strip()
        if not body:
            raise ValidationFailed("Add some text to train on", code="EMPTY_SOURCE")
        _check_room(db, bot, len(body))
        s.title = (data.title or body.split("\n", 1)[0])[:120].strip() or "Text"
        db.add(s)
        db.flush()
        _set_content(db, bot, s, body)
    elif data.kind == "faq":
        q, a = (data.question or "").strip(), (data.content or "").strip()
        if not q or not a:
            raise ValidationFailed("A FAQ needs a question and an answer", code="EMPTY_SOURCE")
        _check_room(db, bot, len(q) + len(a))
        s.question, s.title = q, q[:300]
        db.add(s)
        db.flush()
        _set_content(db, bot, s, a)
    else:
        try:
            clean, _ = fetch.check_url(data.url or "")
        except fetch.FetchError as exc:
            raise ValidationFailed(str(exc), code="URL_NOT_ALLOWED") from exc
        if db.scalar(select(ChatKnowledgeSource.id).where(ChatKnowledgeSource.bot_id == bot.id,
                                                          ChatKnowledgeSource.kind == "url",
                                                          ChatKnowledgeSource.url == clean)):
            raise ValidationFailed("This page is already in the training sources", code="DUPLICATE_SOURCE")
        s.url, s.title, s.status = clean, (data.title or clean)[:300], "processing"
        s.meta = {"crawl": bool(data.crawl), "max_pages": min(data.max_pages, settings.CHAT_CRAWL_MAX_PAGES)}
        db.add(s)
        db.flush()
    return s


def add_file(db: Session, ctx, bot: ChatBot, filename: str, data: bytes) -> ChatKnowledgeSource:
    if len(data) > settings.CHAT_UPLOAD_MAX_BYTES:
        raise ValidationFailed(f"Files can be up to {settings.CHAT_UPLOAD_MAX_BYTES // 1_000_000} MB",
                               code="FILE_TOO_LARGE")
    try:
        body = fetch.file_text(filename, data)
    except fetch.FetchError as exc:
        raise ValidationFailed(str(exc), code="UNREADABLE_FILE") from exc
    _check_room(db, bot, len(body))
    name = re.sub(r"[\x00-\x1f]", "", filename)[-200:] or "Upload"
    s = ChatKnowledgeSource(organization_id=bot.organization_id, application_id=bot.application_id, bot_id=bot.id,
                            kind="file", title=name, meta={"filename": name, "bytes": len(data)},
                            created_by_id=ctx.user.id if ctx.user else None)
    db.add(s)
    db.flush()
    _set_content(db, bot, s, body)
    return s


def update_source(db: Session, bot: ChatBot, source_id: str, data: SourceUpdate) -> ChatKnowledgeSource:
    s = source_row(db, bot, source_id)
    changes = data.model_dump(exclude_unset=True)
    if "title" in changes and changes["title"] is not None:
        s.title = changes["title"].strip()[:300] or s.title
    if s.kind in ("text", "faq"):
        new_q = changes.get("question")
        if s.kind == "faq" and new_q is not None:
            if not new_q.strip():
                raise ValidationFailed("A FAQ needs a question", code="EMPTY_SOURCE")
            s.question, s.title = new_q.strip(), new_q.strip()[:300]
        new_c = changes.get("content")
        body = new_c.strip() if new_c is not None else (s.content or "")
        if not body:
            raise ValidationFailed("The content can't be empty", code="EMPTY_SOURCE")
        _check_room(db, bot, len(body), s.char_count)
        _set_content(db, bot, s, body)
    db.flush()
    return s


def delete_source(db: Session, bot: ChatBot, source_id: str) -> None:
    s = source_row(db, bot, source_id)
    db.delete(s)
    db.flush()
    refresh_totals(db, bot)


def resync(db: Session, bot: ChatBot, source_id: str) -> ChatKnowledgeSource:
    s = source_row(db, bot, source_id)
    if s.kind == "url":
        s.status, s.error = "processing", None
    else:
        _set_content(db, bot, s, s.content or "")
    return s


def sync_source_job(source_id: str) -> str:
    """Fetch a web page (or crawl the site) for a URL source. Runs after the request, with its own session."""
    with SessionLocal() as db:
        s = db.get(ChatKnowledgeSource, source_id)
        if s is None or s.kind != "url":
            return "missing"
        bot = db.get(ChatBot, s.bot_id)
        meta = dict(s.meta or {})
        try:
            if meta.get("crawl"):
                res = fetch.crawl(s.url or "", int(meta.get("max_pages") or 10))
                pages, skipped = res.pages, res.skipped
            else:
                page, _ = fetch.read_page(s.url or "")
                pages, skipped = [page], []
            body = fetch.pages_to_content(pages) if meta.get("crawl") else pages[0].text.strip()
            if not body.strip():
                raise fetch.FetchError("We couldn't find any readable text on that page")
            if not meta.get("crawl") and pages[0].title and (not s.title or s.title == s.url):
                s.title = pages[0].title[:300]
            refresh_totals(db, bot)
            room = settings.CHAT_KNOWLEDGE_MAX_CHARS - (bot.knowledge_chars - (s.char_count if s.status == "ready" else 0))
            if room <= 0:
                raise fetch.FetchError("This chatbot's training is full. Remove some sources first.")
            meta.update(pages=[{"url": p.url, "title": p.title, "chars": len(p.text)} for p in pages][:100],
                        skipped=skipped[:50])
            s.meta = meta
            _set_content(db, bot, s, body[:room])
            db.commit()
            return "ready"
        except fetch.FetchError as exc:
            db.rollback()
            s = db.get(ChatKnowledgeSource, source_id)
            s.status, s.error, s.last_synced_at = "failed", str(exc)[:500], utcnow()
            db.execute(delete(ChatKnowledgeChunk).where(ChatKnowledgeChunk.source_id == s.id))
            refresh_totals(db, db.get(ChatBot, s.bot_id))
            db.commit()
            return "failed"
        except Exception:
            db.rollback()
            log.exception("chat_source_sync_failed", source_id=source_id)
            s = db.get(ChatKnowledgeSource, source_id)
            if s is not None:
                s.status, s.error = "failed", "Something went wrong while reading this page. Try again."
                db.commit()
            return "error"


# ------------------------------------------------------------------ the improve-answer loop


def improve(db: Session, ctx, bot: ChatBot, data: ImproveAnswer) -> ChatKnowledgeSource:
    """Save a corrected answer as a FAQ (Q = what the visitor asked) and mark the unanswered question resolved."""
    q = data.question.strip()
    existing = db.scalar(select(ChatKnowledgeSource).where(ChatKnowledgeSource.bot_id == bot.id,
                                                           ChatKnowledgeSource.kind == "faq",
                                                           ChatKnowledgeSource.question == q))
    if existing is not None:
        s = update_source(db, bot, existing.id, SourceUpdate(content=data.answer))
    else:
        s = add_source(db, ctx, bot, SourceCreate(kind="faq", question=q, content=data.answer))
    if data.message_id:
        s.meta = {**(s.meta or {}), "from_message": data.message_id}
    # Every unanswered copy of this question (in this bot's conversations) is now answered.
    from app.models.chat import ChatConversation

    conv_ids = select(ChatConversation.id).where(ChatConversation.bot_id == bot.id)
    conds = [ChatMessage.question == q]
    if data.message_id:
        conds.append(ChatMessage.id == data.message_id)
    for m in db.scalars(select(ChatMessage).where(ChatMessage.conversation_id.in_(conv_ids),
                                                  ChatMessage.application_id == bot.application_id, or_(*conds))):
        m.flag = "resolved" if m.flag == "unanswered" else m.flag
        m.meta = {**(m.meta or {}), "improved": True}
    db.flush()
    return s


# ------------------------------------------------------------------ knowledge for a reply


def inline_knowledge(db: Session, bot: ChatBot) -> tuple[str, bool]:
    """(the knowledge text placed in the cached prompt, whether retrieval is needed for the rest)."""
    rows = sources(db, bot.id, ready_only=True)
    total = sum(s.char_count for s in rows)
    if total <= settings.CHAT_KNOWLEDGE_INLINE_CHARS:
        return _format(rows), False
    faqs, size = [], 0
    for s in rows:
        if s.kind == "faq" and size + s.char_count <= FAQ_INLINE_CAP:
            faqs.append(s)
            size += s.char_count
    return _format(faqs), True


def _format(rows: list[ChatKnowledgeSource]) -> str:
    parts = []
    faqs = [s for s in rows if s.kind == "faq"]
    if faqs:
        parts.append("# Frequently asked questions\n\n" + "\n\n".join(source_text(s) for s in faqs))
    for s in rows:
        if s.kind == "faq":
            continue
        label = {"text": "Notes", "url": "Website", "file": "Document"}.get(s.kind, "Source")
        where = f" ({s.url})" if s.url else ""
        parts.append(f"# {label}: {s.title}{where}\n\n{(s.content or '').strip()}")
    return "\n\n".join(parts)


FULLTEXT_SQL = text(
    "SELECT c.id, c.title, c.content FROM chat_knowledge_chunks c "
    "JOIN chat_knowledge_sources s ON s.id = c.source_id "
    "WHERE c.bot_id = :bot AND s.status = 'ready' AND (:all_kinds = 1 OR s.kind <> 'faq') "
    "AND MATCH (c.content) AGAINST (:q IN NATURAL LANGUAGE MODE) "
    "ORDER BY MATCH (c.content) AGAINST (:q IN NATURAL LANGUAGE MODE) DESC LIMIT :k")


def _fulltext_query(question: str) -> str:
    return " ".join(words(question)[:24])


def retrieve(db: Session, bot: ChatBot, question: str, k: int = TOP_K, exclude_faq: bool = True) -> list[dict]:
    """The best chunks for a question: FULLTEXT relevance first, keyword overlap as the fallback."""
    q = _fulltext_query(question)
    if not q:
        return []
    found: list[tuple[str, str, str]] = []
    if db.bind.dialect.name == "mysql":
        try:
            with db.begin_nested():
                found = [tuple(r) for r in db.execute(FULLTEXT_SQL, {"bot": bot.id, "q": q, "k": k,
                                                                     "all_kinds": 0 if exclude_faq else 1})]
        except Exception:  # noqa: BLE001 - e.g. the index is missing: use the keyword fallback
            log.warning("chat_fulltext_failed", bot_id=bot.id)
            found = []
    if len(found) < k:
        found += [r for r in _keyword_search(db, bot, question, k, exclude_faq) if r[0] not in {f[0] for f in found}]
    return [{"id": i, "title": t, "content": c} for i, t, c in found[:k]]


def _keyword_search(db: Session, bot: ChatBot, question: str, k: int, exclude_faq: bool) -> list[tuple[str, str, str]]:
    terms = sorted(set(words(question)), key=len, reverse=True)[:8]
    if not terms:
        return []
    q = (select(ChatKnowledgeChunk.id, ChatKnowledgeChunk.title, ChatKnowledgeChunk.content)
         .join(ChatKnowledgeSource, ChatKnowledgeSource.id == ChatKnowledgeChunk.source_id)
         .where(ChatKnowledgeChunk.bot_id == bot.id, ChatKnowledgeSource.status == "ready",
                or_(*[ChatKnowledgeChunk.content.ilike(f"%{t}%") for t in terms])).limit(300))
    if exclude_faq:
        q = q.where(ChatKnowledgeSource.kind != "faq")
    scored = []
    for cid, title, content in db.execute(q):
        counts = Counter(words(content))
        score = sum(min(counts.get(t, 0), 5) for t in terms) + sum(3 for t in terms if t in counts)
        scored.append((score, cid, title, content))
    scored.sort(key=lambda x: -x[0])
    return [(cid, title, content) for _, cid, title, content in scored[:k]]


def simulated_kb(db: Session, bot: ChatBot, question: str) -> dict:
    """What the offline responder may use: every FAQ, and the passages that best match the question."""
    faqs = [(s.question or "", s.content or "") for s in sources(db, bot.id, ready_only=True) if s.kind == "faq"]
    passages = [c["content"] for c in retrieve(db, bot, question, k=3)] if question else []
    return {"faqs": faqs, "passages": passages}
