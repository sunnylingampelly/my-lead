/*! Signalcraft chat widget loader. Paste: <script src=".../embed/chat.js" data-bot="KEY" async></script>
 *  JS API: Signalcraft.chat.open() / close() / toggle() / identify({name, email, phone})
 *          / setAttributes({...}) / on('lead' | 'open' | 'close' | 'message', fn) / off(event, fn)
 *  The launcher lives in a closed shadow root (no style clashes with the page); the chat itself runs in an
 *  iframe served by Signalcraft, isolated from the page. Messages between them are origin-checked. */
(function () {
  "use strict";
  var w = window, d = document;
  var root = (w.Signalcraft = w.Signalcraft || {});
  if (root.chat && root.chat._loaded) return;
  var script = d.currentScript || d.querySelector('script[data-bot][src*="/embed/chat.js"]');
  var key = script && script.getAttribute("data-bot");
  if (!key) return;
  var base = new URL(script.src, location.href).origin;
  var VERSION = "__SC_VERSION__";
  var listeners = {}, pending = [], frame = null, ready = false, isOpen = false, cfg = null, ui = null;
  var earlier = root.chat && root.chat.q ? root.chat.q : [];

  function emit(name, data) {
    (listeners[name] || []).slice().forEach(function (fn) {
      try { fn(data); } catch (e) { if (w.console) console.error(e); }
    });
  }
  function post(msg) {
    msg = Object.assign({ sc: 1 }, msg);
    if (frame && ready) frame.contentWindow.postMessage(msg, base);
    else pending.push(msg);
  }
  function pageInfo() {
    return { type: "page", url: location.href, title: d.title, referrer: d.referrer, host: location.origin };
  }

  var api = {
    _loaded: true,
    open: function () { if (ui) openChat(true); else pending.push({ sc: 1, type: "__open" }); },
    close: function () { if (ui) closeChat(); },
    toggle: function () { if (isOpen) api.close(); else api.open(); },
    identify: function (data) {
      if (!data || typeof data !== "object") return;
      post({ type: "identify", data: { name: data.name, email: data.email, phone: data.phone } });
    },
    setAttributes: function (attrs) {
      if (attrs && typeof attrs === "object") post({ type: "attributes", data: attrs });
    },
    on: function (name, fn) { if (typeof fn === "function") (listeners[name] = listeners[name] || []).push(fn); },
    off: function (name, fn) { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn; }); },
  };
  root.chat = api;
  earlier.forEach(function (c) { try { api[c[0]].apply(api, [].slice.call(c, 1)); } catch (e) { /* ignore */ } });

  function mobile() { return w.matchMedia && w.matchMedia("(max-width: 640px)").matches; }
  function pathMatches(paths) {
    if (!paths || !paths.length) return true;
    var p = location.pathname;
    return paths.some(function (pat) {
      pat = String(pat || "").trim();
      if (!pat) return false;
      if (pat.charAt(pat.length - 1) === "*") return p.indexOf(pat.slice(0, -1)) === 0;
      return p === pat || p === pat.replace(/\/$/, "");
    });
  }

  var ICONS = {
    chat: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5z"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.2-2.4 3.7" stroke="#fff" stroke-width="1.8" fill="none" stroke-linecap="round"/><circle cx="12" cy="17" r="1.1" fill="#fff"/>',
    sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM18.5 14l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
    wave: '<path d="M7.5 11.5V6a1.5 1.5 0 0 1 3 0v4.5V4.8a1.5 1.5 0 0 1 3 0v5.7V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-.6a6 6 0 0 1-4.6-2.2L3 14.6a1.5 1.5 0 0 1 2.2-2z"/>',
    close: '<path d="M6 6l12 12M18 6L6 18" stroke="#fff" stroke-width="2.2" stroke-linecap="round" fill="none"/>',
  };
  function svg(name) {
    return '<svg viewBox="0 0 24 24" width="26" height="26" fill="#fff" aria-hidden="true" focusable="false">' + ICONS[name] + "</svg>";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function css(a) {
    var side = a.position === "left" ? "left" : "right";
    var x = (a.offset_x | 0) + "px", y = (a.offset_y | 0) + "px";
    return ":host{all:initial}" +
      "*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}" +
      ".wrap{position:fixed;z-index:2147483000;" + side + ":" + x + ";bottom:" + y + ";display:flex;flex-direction:column;align-items:" + (side === "left" ? "flex-start" : "flex-end") + ";gap:12px;pointer-events:none}" +
      ".wrap>*{pointer-events:auto}" +
      ".btn{display:flex;align-items:center;gap:8px;height:56px;min-width:56px;padding:0 15px;border:0;border-radius:28px;background:var(--c);color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(15,23,42,.24);transition:transform .15s ease,box-shadow .15s ease;font-size:15px;font-weight:600;position:relative}" +
      ".btn:hover{transform:translateY(-1px);box-shadow:0 10px 26px rgba(15,23,42,.28)}" +
      ".btn:focus-visible{outline:3px solid #fff;outline-offset:2px;box-shadow:0 0 0 6px var(--c)}" +
      ".badge{position:absolute;top:-4px;" + (side === "left" ? "right" : "left") + ":-4px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#ef4444;color:#fff;font-size:12px;font-weight:700;line-height:20px;text-align:center;border:2px solid #fff}" +
      ".badge[hidden],.bubble[hidden],.frame[hidden]{display:none}" +
      ".frame{width:380px;height:min(640px,calc(100vh - 110px));border:0;border-radius:16px;box-shadow:0 16px 48px rgba(15,23,42,.28);background:#fff;color-scheme:normal}" +
      ".bubble{max-width:280px;background:#fff;color:#0f172a;border-radius:14px;padding:12px 34px 12px 14px;box-shadow:0 8px 28px rgba(15,23,42,.2);font-size:14px;line-height:1.45;position:relative;cursor:pointer;animation:pop .25s ease}" +
      ".bubble .x{position:absolute;top:6px;right:6px;width:22px;height:22px;border:0;border-radius:11px;background:#f1f5f9;color:#334155;cursor:pointer;font-size:14px;line-height:22px;padding:0}" +
      "@keyframes pop{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}" +
      "@media (max-width:640px){.frame{width:calc(100vw - 24px);height:calc(100vh - 100px)}" +
      (a.mobile_fullscreen ? ".wrap.open{inset:0;left:0;right:0;bottom:0;gap:0}.wrap.open .frame{width:100vw;height:100%;height:100dvh;border-radius:0}.wrap.open .btn{display:none}" : "") + "}" +
      "@media (prefers-reduced-motion:reduce){.btn,.bubble{transition:none;animation:none}}";
  }

  function build(c) {
    var a = c.appearance || {};
    var host = d.createElement("div");
    host.id = "signalcraft-chat";
    host.setAttribute("data-signalcraft", "chat");
    var shadow = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
    var style = d.createElement("style");
    style.textContent = css(a);
    var wrap = d.createElement("div");
    wrap.className = "wrap";
    wrap.style.setProperty("--c", /^#[0-9a-f]{6}$/i.test(a.color || "") ? a.color : "#4f46e5");
    var bubble = d.createElement("div");
    bubble.className = "bubble";
    bubble.hidden = true;
    bubble.setAttribute("role", "status");
    var btn = d.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.setAttribute("aria-label", "Open chat");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = svg(ICONS[a.launcher_icon] ? a.launcher_icon : "chat") + (a.launcher_text ? "<span>" + esc(a.launcher_text) + "</span>" : "") + '<span class="badge" hidden></span>';
    wrap.appendChild(bubble);
    wrap.appendChild(btn);
    shadow.appendChild(style);
    shadow.appendChild(wrap);
    (d.body || d.documentElement).appendChild(host);
    return { host: host, shadow: shadow, wrap: wrap, btn: btn, bubble: bubble, badge: btn.querySelector(".badge"), a: a };
  }

  function makeFrame() {
    if (frame) return frame;
    frame = d.createElement("iframe");
    frame.className = "frame";
    frame.hidden = true;
    frame.title = (cfg && cfg.name ? cfg.name + " " : "") + "chat";
    frame.setAttribute("allow", "clipboard-write");
    frame.src = base + "/embed/chat/" + encodeURIComponent(key) + "?v=" + VERSION + "&h=" + encodeURIComponent(location.origin);
    ui.wrap.insertBefore(frame, ui.bubble);
    return frame;
  }

  function setBadge(n) {
    if (!ui) return;
    ui.badge.hidden = !n;
    ui.badge.textContent = n > 9 ? "9+" : String(n || "");
    ui.btn.setAttribute("aria-label", n ? "Open chat, " + n + " unread message" + (n > 1 ? "s" : "") : "Open chat");
  }

  function openChat(focus) {
    makeFrame();
    isOpen = true;
    frame.hidden = false;
    ui.bubble.hidden = true;
    ui.wrap.classList.add("open");
    ui.btn.setAttribute("aria-expanded", "true");
    ui.btn.setAttribute("aria-label", "Close chat");
    ui.btn.innerHTML = svg("close") + '<span class="badge" hidden></span>';
    ui.badge = ui.btn.querySelector(".badge");
    post({ type: "open" });
    if (focus) setTimeout(function () { try { frame.focus(); } catch (e) { /* ignore */ } }, 50);
    emit("open");
  }

  function closeChat() {
    if (!frame || !isOpen) return;
    isOpen = false;
    frame.hidden = true;
    ui.wrap.classList.remove("open");
    var a = ui.a;
    ui.btn.setAttribute("aria-expanded", "false");
    ui.btn.innerHTML = svg(ICONS[a.launcher_icon] ? a.launcher_icon : "chat") + (a.launcher_text ? "<span>" + esc(a.launcher_text) + "</span>" : "") + '<span class="badge" hidden></span>';
    ui.badge = ui.btn.querySelector(".badge");
    setBadge(0);
    post({ type: "close" });
    try { ui.btn.focus(); } catch (e) { /* ignore */ }
    emit("close");
  }

  function proactive(p) {
    if (!p || !p.enabled || !p.message || !pathMatches(p.paths)) return;
    var k = "sc-proactive-" + key;
    try { if (sessionStorage.getItem(k)) return; } catch (e) { /* storage blocked */ }
    setTimeout(function () {
      if (isOpen) return;
      ui.bubble.innerHTML = '<button type="button" class="x" aria-label="Dismiss">×</button><span></span>';
      ui.bubble.querySelector("span").textContent = p.message;
      ui.bubble.hidden = false;
      try { sessionStorage.setItem(k, "1"); } catch (e) { /* ignore */ }
      ui.bubble.querySelector(".x").addEventListener("click", function (e) { e.stopPropagation(); ui.bubble.hidden = true; });
      ui.bubble.addEventListener("click", function () { post({ type: "proactive", text: p.message }); openChat(true); });
      makeFrame();
      post({ type: "proactive_shown", text: p.message });
    }, Math.max(0, (p.delay_seconds | 0) * 1000));
  }

  w.addEventListener("message", function (e) {
    if (!frame || e.source !== frame.contentWindow || e.origin !== base) return;
    var m = e.data;
    if (!m || typeof m !== "object" || m.sc !== 1) return;
    if (m.type === "ready") {
      ready = true;
      frame.contentWindow.postMessage(Object.assign({ sc: 1 }, pageInfo()), base);
      if (isOpen) frame.contentWindow.postMessage({ sc: 1, type: "open" }, base);
      pending.splice(0).forEach(function (p) { if (p.type !== "__open") frame.contentWindow.postMessage(p, base); });
    } else if (m.type === "close") closeChat();
    else if (m.type === "unread") { if (!isOpen) setBadge(m.count | 0); }
    else if (m.type === "lead") emit("lead", m.data || {});
    else if (m.type === "message") emit("message", m.data || {});
  });

  function init(c) {
    cfg = c;
    if (mobile() && c.appearance && c.appearance.show_on_mobile === false) return;
    ui = build(c);
    ui.btn.addEventListener("click", function () { if (isOpen) closeChat(); else openChat(true); });
    d.addEventListener("keydown", function (e) { if (e.key === "Escape" && isOpen) closeChat(); });
    var start = function () { makeFrame(); };
    if (w.requestIdleCallback) w.requestIdleCallback(start, { timeout: 3000 }); else setTimeout(start, 1200);
    proactive(c.proactive);
    if (pending.some(function (p) { return p.type === "__open"; })) openChat(false);
    var last = location.href;
    setInterval(function () { if (location.href !== last) { last = location.href; post(pageInfo()); } }, 1500);
  }

  function boot() {
    fetch(base + "/api/v1/public/chat/" + encodeURIComponent(key) + "/config?host=" + encodeURIComponent(location.origin), { credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) { if (c) init(c); })
      .catch(function () { /* the widget simply doesn't show */ });
  }
  if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", boot); else boot();
})();
