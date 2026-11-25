/*! Signalcraft chat widget (runs inside the iframe served by /embed/chat/{key}). Vanilla JS, no frameworks.
 *  Security: all text is inserted as text nodes (never innerHTML); links are limited to http(s); the visitor token
 *  is HMAC-signed by the server and kept in this iframe's localStorage. */
(function () {
  "use strict";
  var d = document, w = window;
  var cfg;
  try { cfg = JSON.parse(d.getElementById("sc-config").textContent); } catch (e) { return; }
  var app = d.getElementById("sc-app");
  var params = new URLSearchParams(location.search);
  var API = cfg.base + "/public/chat/" + encodeURIComponent(cfg.key);
  var TOKEN_KEY = "sc:v:" + cfg.key;
  var embedded = w.parent !== w;
  var S = {
    token: null, conv: null, messages: [], lastAt: null, open: !embedded, unread: 0, busy: false,
    host: params.get("h") || null, page: { url: null, title: null, referrer: null },
    identity: {}, attrs: null, streaming: null, typing: false, pollTimer: null, proactive: null,
    view: "chat", formOpen: null, error: null, closedPanel: false, visitorEmail: null, sentFirst: false,
  };
  var a = cfg.appearance || {};

  // ------------------------------------------------------------------ storage (may be blocked)
  function load(k) { try { return w.localStorage.getItem(k); } catch (e) { return null; } }
  function save(k, v) { try { if (v == null) w.localStorage.removeItem(k); else w.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  // ------------------------------------------------------------------ DOM helpers
  function h(tag, attrs, kids) {
    var el = d.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c != null && c !== false) el.appendChild(typeof c === "string" ? d.createTextNode(c) : c); });
    return el;
  }
  var ICON = {
    send: "M3.4 20.4l17.4-7.5c.8-.3.8-1.5 0-1.8L3.4 3.6c-.7-.3-1.4.4-1.2 1.1L4 11l9 1-9 1-1.8 6.3c-.2.7.5 1.4 1.2 1.1z",
    close: "M6 6l12 12M18 6L6 18", more: "M12 6.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm0 7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm0 7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z",
    up: "M7 10v10H4V10zm2 10h8.4a2 2 0 0 0 2-1.6l1.3-6A2 2 0 0 0 18.8 10H14l.7-3.6A2 2 0 0 0 12.8 4L9 10z",
    down: "M17 14V4h3v10zm-2-10H6.6a2 2 0 0 0-2 1.6l-1.3 6A2 2 0 0 0 5.2 14H10l-.7 3.6a2 2 0 0 0 1.9 2.4L15 14z",
    person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0z",
  };
  function icon(name, stroke) {
    var ns = "http://www.w3.org/2000/svg";
    var s = d.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", "20"); s.setAttribute("height", "20");
    s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false");
    var p = d.createElementNS(ns, "path");
    p.setAttribute("d", ICON[name]);
    if (stroke) { p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "2.2"); p.setAttribute("stroke-linecap", "round"); p.setAttribute("fill", "none"); }
    else p.setAttribute("fill", "currentColor");
    s.appendChild(p);
    return s;
  }

  // Markdown-lite: **bold**, [text](https://…), bare https:// links, "- " lists, line breaks. Text nodes only.
  function inline(text, parent) {
    var re = /\*\*([^*\n]{1,300})\*\*|\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)|(https?:\/\/[^\s<>()"']{2,500})/g;
    var last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(d.createTextNode(text.slice(last, m.index)));
      if (m[1]) parent.appendChild(h("strong", { text: m[1] }));
      else {
        var href = m[3] || m[4], label = m[2] || m[4];
        var trail = "";
        if (!m[3]) { var t = /[.,;:!?]+$/.exec(href); if (t) { trail = t[0]; href = href.slice(0, -trail.length); label = href; } }
        parent.appendChild(h("a", { href: href, target: "_blank", rel: "noopener noreferrer nofollow ugc", text: label }));
        if (trail) parent.appendChild(d.createTextNode(trail));
      }
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(d.createTextNode(text.slice(last)));
  }
  function rich(text) {
    var box = h("div", { class: "sc-text" });
    var lines = String(text || "").split("\n"), list = null, para = null;
    lines.forEach(function (line) {
      var li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        if (!list) { list = h("ul"); box.appendChild(list); }
        var item = h("li"); inline(li[1], item); list.appendChild(item); para = null;
      } else if (!line.trim()) { list = null; para = null; }
      else {
        list = null;
        if (para) para.appendChild(h("br")); else { para = h("p"); box.appendChild(para); }
        inline(line, para);
      }
    });
    return box;
  }

  // ------------------------------------------------------------------ API
  function req(method, path, body, opts) {
    var headers = { "Content-Type": "application/json" };
    if (S.token) headers["X-Visitor-Token"] = S.token;
    return fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: "omit", signal: opts && opts.signal })
      .then(function (r) {
        if (r.status === 401) { save(TOKEN_KEY, null); S.token = null; }
        if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) {
          var err = new Error((j.error && j.error.message) || "Something went wrong. Please try again.");
          err.status = r.status; err.code = j.error && j.error.code; err.field = j.error && j.error.details && j.error.details.field;
          throw err;
        });
        return r;
      });
  }
  function json(method, path, body) { return req(method, path, body).then(function (r) { return r.json(); }); }
  function pageBody() { return { url: S.page.url, title: S.page.title, referrer: S.page.referrer, host: S.host }; }

  function merge(list) {
    var seen = {};
    S.messages.forEach(function (m) { seen[m.id] = m; });
    var fresh = [];
    (list || []).forEach(function (m) {
      if (seen[m.id]) { Object.assign(seen[m.id], m); return; }
      S.messages.push(m); seen[m.id] = m; fresh.push(m);
    });
    S.messages = S.messages.filter(function (m) { return m.id.indexOf("tmp-") !== 0 || !fresh.some(function (f) { return f.role === "visitor" && f.body === m.body; }); });
    S.messages.sort(function (x, y) { return x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : 0; });
    var real = S.messages.filter(function (m) { return m.id.indexOf("tmp-") !== 0; });
    if (real.length) S.lastAt = real[real.length - 1].created_at;
    return fresh;
  }
  function applyState(out) {
    if (out.conversation !== undefined) S.conv = out.conversation;
    var fresh = merge(out.messages || []);
    var incoming = fresh.filter(function (m) { return m.role === "agent" || m.role === "bot" || (m.role === "system" && m.meta && m.meta.event === "joined"); });
    if (incoming.length && !S.open && S.sentFirst) { S.unread += incoming.length; tellParent({ type: "unread", count: S.unread }); ding(); }
    else if (incoming.some(function (m) { return m.role === "agent"; }) && d.hidden) ding();
    return fresh;
  }

  function init() {
    S.token = load(TOKEN_KEY);
    return json("POST", "/visitor", { page: pageBody() }).then(function (out) {
      S.token = out.token; save(TOKEN_KEY, out.token);
      S.visitorEmail = out.visitor && out.visitor.email;
      if (out.conversation && !out.conversation.closed) { applyState(out); S.sentFirst = true; }
      else if (out.conversation && out.conversation.closed) { S.conv = null; }
      render(); schedulePoll();
    }).catch(function (e) { S.error = e.message; render(); });
  }

  // Startup (visitor token) must finish before the first message: a fast typist can send before /visitor
  // answers. If the token is missing or was rejected, start a fresh visitor session once and retry, rather
  // than telling the visitor to reload.
  var ready = null;
  function whenReady() {
    if (!ready) ready = init();
    return ready.then(function () {
      if (S.token) return;
      ready = init();
      return ready;
    });
  }
  function ensureConversation(retried) {
    if (S.conv && !S.conv.closed) return Promise.resolve(S.conv);
    return whenReady().then(function () {
      return json("POST", "/conversations", { page: pageBody() });
    }).then(function (out) {
      S.messages = []; S.closedPanel = false; applyState(out); S.sentFirst = true; return S.conv;
    }, function (e) {
      if (e && e.status === 401 && !retried) { ready = null; return ensureConversation(true); }
      throw e;
    });
  }

  // ------------------------------------------------------------------ sending and streaming
  function send(text) {
    text = String(text || "").trim().slice(0, 2000);
    if (!text || S.busy) return;
    S.busy = true; S.error = null;
    var tmp = { id: "tmp-" + Date.now(), role: "visitor", body: text, created_at: new Date().toISOString(), meta: {} };
    ensureConversation().then(function () {
      S.messages.push(tmp); S.typing = true; render(true);
      return req("POST", "/conversations/" + S.conv.id + "/messages", { text: text, stream: true, host: S.host });
    }).then(function (res) {
      var reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (!reader) return res.text().then(function (t) { parseSSE(t, true); });
      var dec = new TextDecoder(), buf = "";
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { parseSSE(buf, true); return; }
          buf += dec.decode(r.value, { stream: true });
          var cut = buf.lastIndexOf("\n\n");
          if (cut !== -1) { parseSSE(buf.slice(0, cut + 2), false); buf = buf.slice(cut + 2); }
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      S.messages = S.messages.filter(function (m) { return m !== tmp; });
      S.error = e.message || "Couldn't send. Check your connection and try again.";
      if (e.code === "LEAD_REQUIRED") S.formOpen = "lead";
    }).then(function () {
      S.busy = false; S.typing = false; S.streaming = null; render(true); schedulePoll(); focusInput();
    });
  }

  function parseSSE(text, final) {
    text.split("\n\n").forEach(function (block) {
      if (!block.trim()) return;
      var ev = "message", data = "";
      block.split("\n").forEach(function (line) {
        if (line.indexOf("event:") === 0) ev = line.slice(6).trim();
        else if (line.indexOf("data:") === 0) data += line.slice(5).trim();
      });
      var payload; try { payload = data ? JSON.parse(data) : {}; } catch (e) { return; }
      if (ev === "delta") {
        S.typing = false;
        S.streaming = (S.streaming || "") + (payload.text || "");
        renderStreaming();
      } else if (ev === "message") {
        if (payload.role !== "visitor") { S.streaming = null; S.typing = false; }
        applyState({ messages: [payload] });
        if (payload.role === "bot" && payload.meta && payload.meta.form === "lead") S.formOpen = null;
        render(true);
        if (payload.role !== "visitor") tellParent({ type: "message", data: { role: payload.role, body: payload.body } });
      } else if (ev === "state") { S.conv = payload; render(); }
      else if (ev === "error") { S.error = payload.message; render(); }
    });
    if (final) { S.typing = false; }
  }

  // ------------------------------------------------------------------ polling (agent replies, status changes)
  function schedulePoll() {
    clearTimeout(S.pollTimer);
    if (!S.conv || S.conv.closed) return;
    S.pollTimer = setTimeout(poll, S.open && !d.hidden ? 2500 : 10000);
  }
  function poll() {
    if (!S.conv || S.busy) { schedulePoll(); return; }
    var q = "?host=" + encodeURIComponent(S.host || "") + (S.lastAt ? "&after=" + encodeURIComponent(S.lastAt) : "");
    json("GET", "/conversations/" + S.conv.id + "/messages" + q).then(function (out) {
      var before = JSON.stringify(S.conv);
      var fresh = applyState(out);
      if (fresh.length || JSON.stringify(S.conv) !== before) render(true);
    }).catch(function () { /* try again later */ }).then(schedulePoll);
  }
  d.addEventListener("visibilitychange", schedulePoll);

  // ------------------------------------------------------------------ actions
  function talkToHuman() {
    if (S.busy) return;
    S.busy = true;
    ensureConversation().then(function () {
      return json("POST", "/conversations/" + S.conv.id + "/handoff", { host: S.host });
    }).then(function (out) { applyState(out); }).catch(function (e) { S.error = e.message; })
      .then(function () { S.busy = false; render(true); schedulePoll(); });
  }
  function submitLead(form, values, consent) {
    var btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    ensureConversation().then(function () {
      return json("POST", "/conversations/" + S.conv.id + "/lead", { values: values, consent: consent, host: S.host });
    }).then(function (out) {
      S.formOpen = null; S.error = null; applyState(out); S.visitorEmail = values.email || S.visitorEmail;
      tellParent({ type: "lead", data: { name: values.name || null, email: values.email || null, phone: values.phone || null } });
      render(true); focusInput();
    }).catch(function (e) { btn.disabled = false; showFormError(form, e); });
  }
  function submitOffline(form, values, consent) {
    var btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    var q = S.conv && !S.conv.closed ? "?conversation_id=" + encodeURIComponent(S.conv.id) : "";
    json("POST", "/offline" + q, { name: values.name || null, email: values.email, phone: values.phone || null, message: values.message, consent: consent, host: S.host })
      .then(function (out) {
        S.formOpen = null; S.error = null; S.messages = S.conv && out.conversation && S.conv.id === out.conversation.id ? S.messages : [];
        applyState(out); S.sentFirst = true;
        tellParent({ type: "lead", data: { name: values.name || null, email: values.email, phone: values.phone || null } });
        render(true); schedulePoll();
      }).catch(function (e) { btn.disabled = false; showFormError(form, e); });
  }
  function endChat() {
    if (!S.conv || S.conv.closed) return;
    json("POST", "/conversations/" + S.conv.id + "/close", { host: S.host }).then(function (out) {
      applyState(out); S.closedPanel = true; render(true);
    }).catch(function (e) { S.error = e.message; render(); });
  }
  function rate(value, comment, box) {
    json("POST", "/conversations/" + S.conv.id + "/rating", { rating: value, comment: comment || null }).then(function (out) {
      applyState(out); box.replaceChildren(h("p", { class: "sc-thanks", text: "Thanks for your feedback!" })); announce("Thanks for your feedback");
    }).catch(function (e) { S.error = e.message; render(); });
  }
  function emailTranscript(email, box) {
    json("POST", "/conversations/" + S.conv.id + "/transcript", { email: email }).then(function () {
      box.replaceChildren(h("p", { class: "sc-thanks", text: "Transcript sent to " + email + "." }));
    }).catch(function (e) { var p = box.querySelector(".sc-err"); if (p) p.textContent = e.message; });
  }
  function newChat() { S.conv = null; S.messages = []; S.lastAt = null; S.closedPanel = false; S.view = "chat"; render(); focusInput(); }

  // ------------------------------------------------------------------ parent window
  function tellParent(msg) { if (embedded) w.parent.postMessage(Object.assign({ sc: 1 }, msg), "*"); }
  w.addEventListener("message", function (e) {
    if (!embedded || e.source !== w.parent) return;
    var m = e.data;
    if (!m || typeof m !== "object" || m.sc !== 1) return;
    if (m.type === "page") {
      S.page = { url: String(m.url || "").slice(0, 2000), title: String(m.title || "").slice(0, 300), referrer: String(m.referrer || "").slice(0, 1000) };
      if (typeof m.host === "string" && /^https?:\/\//.test(m.host)) S.host = m.host.slice(0, 300);
      if (S.token) req("POST", "/page", pageBody()).catch(function () {});
    } else if (m.type === "open") { S.open = true; S.unread = 0; tellParent({ type: "unread", count: 0 }); render(true); focusInput(); schedulePoll(); }
    else if (m.type === "close") { S.open = false; schedulePoll(); }
    else if (m.type === "identify" && m.data) {
      S.identity = { name: m.data.name ? String(m.data.name).slice(0, 200) : null, email: m.data.email ? String(m.data.email).slice(0, 320) : null, phone: m.data.phone ? String(m.data.phone).slice(0, 40) : null };
      syncIdentity();
    } else if (m.type === "attributes" && m.data) { S.attrs = m.data; syncIdentity(); }
    else if (m.type === "proactive" || m.type === "proactive_shown") {
      if (!S.conv && typeof m.text === "string") { S.proactive = m.text.slice(0, 300); render(); }
    }
  });
  function syncIdentity() {
    if (!S.token) return;
    var body = { page: pageBody(), name: S.identity.name, email: S.identity.email, phone: S.identity.phone, attributes: S.attrs };
    req("POST", "/visitor", body).catch(function () {});
  }

  // ------------------------------------------------------------------ sound
  var audio = null;
  d.addEventListener("pointerdown", function () { if (!audio && (w.AudioContext || w.webkitAudioContext)) { try { audio = new (w.AudioContext || w.webkitAudioContext)(); } catch (e) { /* ignore */ } } }, { once: true });
  function ding() {
    if (!a.sound || !audio) return;
    try {
      var o = audio.createOscillator(), g = audio.createGain();
      o.type = "sine"; o.frequency.value = 880; g.gain.value = 0.0001;
      o.connect(g); g.connect(audio.destination);
      var t = audio.currentTime;
      g.gain.exponentialRampToValueAtTime(0.08, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.start(t); o.stop(t + 0.4);
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ rendering
  var els = {};
  function announce(text) { if (els.live) { els.live.textContent = ""; setTimeout(function () { els.live.textContent = text; }, 30); } }
  function focusInput() { if (els.input && !els.input.disabled && S.open) setTimeout(function () { try { els.input.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 0); }

  function shell() {
    var theme = a.theme === "auto" ? (w.matchMedia && w.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : (a.theme || "light");
    d.documentElement.classList.add("sc-" + theme);
    d.documentElement.style.setProperty("--sc-brand", /^#[0-9a-f]{6}$/i.test(a.color || "") ? a.color : "#4f46e5");
    var avatar = cfg.avatar_url ? h("img", { class: "sc-avatar", src: cfg.avatar_url, alt: "" }) : h("span", { class: "sc-avatar sc-avatar-initial", "aria-hidden": "true", text: (cfg.name || "?").charAt(0).toUpperCase() });
    els.status = h("span", { class: "sc-sub" });
    els.menu = h("div", { class: "sc-menu", role: "menu", hidden: true }, [
      h("button", { type: "button", role: "menuitem", text: "Email me the transcript", onclick: function () { els.menu.hidden = true; showTranscriptForm(); } }),
      h("button", { type: "button", role: "menuitem", text: "End chat", onclick: function () { els.menu.hidden = true; endChat(); } }),
    ]);
    var menuBtn = h("button", { type: "button", class: "sc-icon-btn", "aria-label": "Chat options", "aria-haspopup": "menu", onclick: function () { els.menu.hidden = !els.menu.hidden; if (!els.menu.hidden) els.menu.querySelector("button").focus(); } }, [icon("more")]);
    els.menuBtn = menuBtn;
    var closeBtn = embedded ? h("button", { type: "button", class: "sc-icon-btn", "aria-label": "Minimise chat", onclick: function () { tellParent({ type: "close" }); } }, [icon("close", true)]) : null;
    var header = h("header", { class: "sc-header" }, [avatar, h("div", { class: "sc-title" }, [h("strong", { text: a.title || cfg.name }), els.status]), menuBtn, closeBtn, els.menu]);
    els.list = h("div", { class: "sc-list", role: "log", "aria-live": "polite", "aria-relevant": "additions", tabindex: "0", "aria-label": "Chat messages" });
    els.live = h("div", { class: "sc-sr", "aria-live": "assertive" });
    els.input = h("textarea", { class: "sc-input", rows: "1", maxlength: "2000", placeholder: "Type your message…", "aria-label": "Message", dir: "auto" });
    els.input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitInput(); }
    });
    els.input.addEventListener("input", function () { els.input.style.height = "auto"; els.input.style.height = Math.min(120, els.input.scrollHeight) + "px"; });
    els.send = h("button", { type: "button", class: "sc-send", "aria-label": "Send message", onclick: submitInput }, [icon("send")]);
    els.human = h("button", { type: "button", class: "sc-human", onclick: talkToHuman }, [icon("person"), "Talk to a human"]);
    els.composer = h("div", { class: "sc-composer" }, [els.input, els.send]);
    els.footer = h("footer", { class: "sc-footer" }, [els.human, els.composer,
      a.show_branding !== false ? h("a", { class: "sc-brand", href: /^https?:\/\//.test(cfg.brand_url || "") ? cfg.brand_url : null, target: "_blank", rel: "noopener noreferrer", text: "Powered by Signalcraft" }) : null]);
    var panel = h("section", { class: "sc-panel", role: embedded ? "dialog" : "region", "aria-label": (cfg.name || "Chat") + " chat" }, [header, els.list, els.live, els.footer]);
    app.appendChild(panel);
    els.panel = panel;
    d.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { if (!els.menu.hidden) { els.menu.hidden = true; menuBtn.focus(); } else if (embedded) tellParent({ type: "close" }); }
      if (e.key === "Tab") trapFocus(e);
    });
    d.addEventListener("click", function (e) { if (!els.menu.hidden && !els.menu.contains(e.target) && e.target !== menuBtn && !menuBtn.contains(e.target)) els.menu.hidden = true; });
  }
  function trapFocus(e) {
    var f = Array.prototype.filter.call(els.panel.querySelectorAll("button,textarea,input,a[href],[tabindex='0']"), function (el) { return !el.disabled && el.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && d.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && d.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function submitInput() {
    var t = els.input.value;
    if (!t.trim() || S.busy) return;
    els.input.value = ""; els.input.style.height = "auto";
    send(t);
  }

  function statusText() {
    if (S.conv && S.conv.agent && S.conv.status === "open") return S.conv.agent.name + " from the team";
    if (S.conv && S.conv.status === "waiting") return S.conv.agents_online ? "Waiting for a team member…" : "We'll reply by email";
    var online = S.conv ? S.conv.agents_online : cfg.agents_online;
    return online ? (a.subtitle || "We usually reply in a few minutes") : (a.subtitle || "Ask us anything");
  }

  function msgNode(m) {
    var meta = m.meta || {};
    if (m.role === "system") return h("div", { class: "sc-system", role: "note", dir: "auto" }, [m.body]);
    var mine = m.role === "visitor";
    var who = m.role === "agent" ? (m.author || "Team") : m.role === "bot" ? (cfg.name || "Assistant") : "You";
    // dir="auto": Arabic and other right-to-left messages render right to left.
    var bubble = h("div", { class: "sc-bubble" + (mine ? " sc-mine" : "") + (m.id.indexOf("tmp-") === 0 ? " sc-pending" : ""), dir: "auto" }, [rich(m.body)]);
    var row = h("div", { class: "sc-row" + (mine ? " sc-row-mine" : ""), "data-id": m.id }, [
      h("span", { class: "sc-sr", text: who + " said:" }), bubble]);
    if (!mine) {
      var tags = [];
      if (m.role === "agent") tags.push(h("span", { class: "sc-meta", text: who }));
      if (meta.simulated) tags.push(h("span", { class: "sc-meta sc-sim", title: "No AI key is configured, so this reply was simulated", text: "Simulated reply" }));
      if (tags.length) row.appendChild(h("div", { class: "sc-meta-row" }, tags));
    }
    return row;
  }

  function lastIs(fn) { var r = S.messages.filter(function (m) { return m.role !== "note"; }); return r.length && fn(r[r.length - 1]); }

  function leadForm(required) {
    var lc = cfg.lead_capture || {};
    var form = h("form", { class: "sc-card sc-form", novalidate: true, "aria-label": "Your contact details" });
    form.appendChild(h("p", { class: "sc-card-title", text: required ? "Before we start, please introduce yourself." : (lc.prompt || "Could you share your details so our team can follow up?") }));
    (lc.fields || []).forEach(function (f, i) {
      var id = "sc-f-" + i;
      var type = f.key === "email" ? "email" : f.key === "phone" ? "tel" : "text";
      var pre = f.key === "email" ? (S.identity.email || S.visitorEmail) : f.key === "name" ? S.identity.name : f.key === "phone" ? S.identity.phone : null;
      form.appendChild(h("label", { for: id, text: f.label + (f.required ? " *" : "") }));
      form.appendChild(h("input", { id: id, name: f.key, type: type, required: f.required, value: pre || null, dir: "auto", autocomplete: f.key === "name" ? "name" : f.key === "email" ? "email" : f.key === "phone" ? "tel" : f.key === "company" ? "organization" : "off", maxlength: "300" }));
    });
    var consent = consentBox(lc.consent, form);
    form.appendChild(h("p", { class: "sc-err", role: "alert" }));
    form.appendChild(h("button", { type: "submit", class: "sc-primary", text: "Send" }));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var values = {};
      Array.prototype.forEach.call(form.querySelectorAll("input[name]"), function (inp) { if (inp.type !== "checkbox") values[inp.name] = inp.value.trim(); });
      var missing = (lc.fields || []).filter(function (f) { return f.required && !values[f.key]; })[0];
      if (missing) return showFormError(form, { message: missing.label + " is required", field: missing.key });
      submitLead(form, values, !!(consent && consent.checked));
    });
    return form;
  }
  function consentBox(c, form) {
    if (!c || !c.enabled) return null;
    var box = h("input", { type: "checkbox", id: "sc-consent-" + Math.random().toString(36).slice(2, 7), class: "sc-check" });
    form.appendChild(h("label", { class: "sc-consent", for: box.id }, [box, h("span", { text: c.text })]));
    return box;
  }
  function offlineForm() {
    var form = h("form", { class: "sc-card sc-form", novalidate: true, "aria-label": "Leave a message" });
    form.appendChild(h("p", { class: "sc-card-title", text: "We're offline right now. Leave a message and we'll get back to you." }));
    [["name", "Name", "text", false], ["email", "Email *", "email", true], ["message", "Message *", "textarea", true]].forEach(function (f, i) {
      var id = "sc-o-" + i;
      form.appendChild(h("label", { for: id, text: f[1] }));
      var pre = f[0] === "email" ? (S.identity.email || S.visitorEmail) : f[0] === "name" ? S.identity.name : null;
      var last = S.messages.filter(function (m) { return m.role === "visitor"; }).slice(-1)[0];
      form.appendChild(f[2] === "textarea" ? h("textarea", { id: id, name: f[0], rows: "3", maxlength: "4000", required: true, text: last ? last.body : "", dir: "auto" })
        : h("input", { id: id, name: f[0], type: f[2], required: f[3], value: pre || null, maxlength: "320", autocomplete: f[0], dir: "auto" }));
    });
    var consent = consentBox((cfg.lead_capture || {}).consent, form);
    form.appendChild(h("p", { class: "sc-err", role: "alert" }));
    form.appendChild(h("button", { type: "submit", class: "sc-primary", text: "Send message" }));
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var v = {};
      Array.prototype.forEach.call(form.querySelectorAll("[name]"), function (inp) { v[inp.name] = inp.value.trim(); });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email || "")) return showFormError(form, { message: "Enter a valid email address", field: "email" });
      if (!v.message) return showFormError(form, { message: "Write a message", field: "message" });
      submitOffline(form, v, !!(consent && consent.checked));
    });
    return form;
  }
  function showFormError(form, e) {
    var p = form.querySelector(".sc-err");
    if (p) p.textContent = e.message || "Please check the form";
    var f = e.field && form.querySelector("[name='" + String(e.field).replace(/[^a-z_:]/gi, "") + "']");
    if (f) { f.setAttribute("aria-invalid", "true"); f.focus(); }
  }
  function showTranscriptForm() {
    if (!S.conv) return;
    var box = h("div", { class: "sc-card" });
    var inp = h("input", { type: "email", "aria-label": "Your email", placeholder: "you@example.com", value: S.identity.email || S.visitorEmail || null, maxlength: "320" });
    box.appendChild(h("p", { class: "sc-card-title", text: "Email me this conversation" }));
    box.appendChild(inp);
    box.appendChild(h("p", { class: "sc-err", role: "alert" }));
    box.appendChild(h("button", { type: "button", class: "sc-primary", text: "Send transcript", onclick: function () { emailTranscript(inp.value.trim(), box); } }));
    els.list.appendChild(box);
    els.list.scrollTop = els.list.scrollHeight;
    inp.focus();
  }
  function ratingCard() {
    var box = h("div", { class: "sc-card sc-rate" });
    if (S.conv && S.conv.rating) { box.appendChild(h("p", { class: "sc-thanks", text: "Thanks for your feedback!" })); return box; }
    var comment = h("textarea", { rows: "2", maxlength: "1000", placeholder: "Anything we could do better? (optional)", "aria-label": "Comment" });
    box.appendChild(h("p", { class: "sc-card-title", text: "How was this chat?" }));
    box.appendChild(h("div", { class: "sc-thumbs" }, [
      h("button", { type: "button", class: "sc-thumb", "aria-label": "Good", onclick: function () { rate("up", comment.value, box); } }, [icon("up")]),
      h("button", { type: "button", class: "sc-thumb", "aria-label": "Bad", onclick: function () { rate("down", comment.value, box); } }, [icon("down")]),
    ]));
    box.appendChild(comment);
    return box;
  }

  function renderStreaming() {
    var node = els.list.querySelector(".sc-streaming");
    if (!node) {
      var t = els.list.querySelector(".sc-typing"); if (t) t.remove();
      node = h("div", { class: "sc-row sc-streaming" }, [h("div", { class: "sc-bubble", dir: "auto" })]);
      els.list.appendChild(node);
    }
    node.firstChild.replaceChildren(rich(S.streaming || ""));
    els.list.scrollTop = els.list.scrollHeight;
  }

  function render(scroll) {
    if (!els.list) shell();
    els.status.textContent = S.error && !S.conv && !S.token ? "Chat is unavailable right now" : statusText();
    var atBottom = els.list.scrollHeight - els.list.scrollTop - els.list.clientHeight < 80;
    var frag = d.createDocumentFragment();
    var visible = S.messages.filter(function (m) { return m.role !== "note"; });
    var lc = cfg.lead_capture || {};
    var leadDone = S.conv && S.conv.lead_captured;
    if (!visible.length) {
      frag.appendChild(msgNode({ id: "welcome", role: "bot", body: cfg.welcome_message || "Hi! How can I help you today?", meta: {}, created_at: "" }));
      if (S.proactive && S.proactive !== cfg.welcome_message) frag.appendChild(msgNode({ id: "proactive", role: "bot", body: S.proactive, meta: {}, created_at: "" }));
    }
    var formShown = false;
    visible.forEach(function (m, i) {
      frag.appendChild(msgNode(m));
      var isLast = i === visible.length - 1;
      var form = m.meta && m.meta.form;
      if (isLast && S.conv && !S.conv.closed && !formShown) {
        if ((form === "lead" || form === "lead_required") && !leadDone) { frag.appendChild(leadForm(form === "lead_required")); formShown = true; }
        else if (form === "offline" && !S.conv.offline) { frag.appendChild(offlineForm()); formShown = true; }
        else if (m.meta && m.meta.offer_human && S.conv.status === "bot") frag.appendChild(h("div", { class: "sc-chips" }, [h("button", { type: "button", class: "sc-chip", text: "Talk to a human", onclick: talkToHuman })]));
      }
    });
    var needLeadFirst = lc.mode === "before" && !leadDone && (!S.conv || !visible.some(function (m) { return m.role === "visitor"; }));
    if (!formShown && needLeadFirst && !(S.conv && S.conv.closed)) { frag.appendChild(leadForm(true)); formShown = true; }
    if (!formShown && S.formOpen === "lead" && !leadDone) { frag.appendChild(leadForm(false)); formShown = true; }
    var chips = null;
    if (!S.busy && !formShown && !(S.conv && S.conv.closed)) {
      var lastBot = visible.length ? visible[visible.length - 1] : null;
      var qr = !visible.length ? (cfg.quick_replies || []) : (lastBot && lastBot.role === "bot" && lastBot.meta && lastBot.meta.quick_replies) || [];
      if (qr.length && !visible.some(function (m) { return m.role === "visitor"; })) {
        chips = h("div", { class: "sc-chips", role: "group", "aria-label": "Suggested replies" }, qr.map(function (c) {
          return h("button", { type: "button", class: "sc-chip", text: c, onclick: function () { if (/human|person|agent|support/i.test(c) && /talk|speak|human/i.test(c)) talkToHuman(); else send(c); } });
        }));
        frag.appendChild(chips);
      }
    }
    if (S.typing) frag.appendChild(h("div", { class: "sc-row sc-typing", "aria-label": "Typing" }, [h("div", { class: "sc-bubble" }, [h("span"), h("span"), h("span")])]));
    if (S.streaming) frag.appendChild(h("div", { class: "sc-row sc-streaming" }, [h("div", { class: "sc-bubble", dir: "auto" }, [rich(S.streaming)])]));
    var closed = S.conv && S.conv.closed;
    if (closed) {
      frag.appendChild(ratingCard());
      frag.appendChild(h("div", { class: "sc-end-actions" }, [
        h("button", { type: "button", class: "sc-link", text: "Email me the transcript", onclick: showTranscriptForm }),
        h("button", { type: "button", class: "sc-primary", text: "Start a new chat", onclick: newChat })]));
    }
    if (S.error) frag.appendChild(h("p", { class: "sc-error", role: "alert", text: S.error }));
    var hadNew = els.list.childNodes.length !== frag.childNodes.length;
    els.list.replaceChildren(frag);
    if (scroll || atBottom) els.list.scrollTop = els.list.scrollHeight;
    var lastMsg = visible[visible.length - 1];
    if (hadNew && lastMsg && lastMsg.role !== "visitor") { var who = lastMsg.role === "agent" ? (lastMsg.author || "Team") : lastMsg.role === "bot" ? cfg.name : ""; announce((who ? who + ": " : "") + lastMsg.body.slice(0, 200)); }
    var blocked = closed || (needLeadFirst && !leadDone);
    els.input.disabled = !!blocked;
    els.send.disabled = !!blocked || S.busy;
    els.input.placeholder = closed ? "This chat has ended" : blocked ? "Share your details to start" : "Type your message…";
    els.human.hidden = !!closed || !!(S.conv && S.conv.status !== "bot") || needLeadFirst;
    els.menuBtn.hidden = !S.conv;
  }

  // ------------------------------------------------------------------ start
  if (!embedded) { S.page = { url: d.referrer || null, title: null, referrer: null }; }
  render();
  if (embedded) tellParent({ type: "ready" });
  whenReady().then(function () {
    if (S.identity.name || S.identity.email || S.identity.phone || S.attrs) syncIdentity();
    else if (S.page.url) req("POST", "/page", pageBody()).catch(function () {});
  });
})();
