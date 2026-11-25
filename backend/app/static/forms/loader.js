/* Signalcraft lead forms loader. Inline: <div data-signalcraft-inline="ID"></div>.
   Popup / slide-in / floating: <script ... data-signalcraft-popup="ID" data-mode="popup"></script>.
   Click trigger: any element with data-signalcraft-form="ID". Forms render in isolated iframes. */
(function () {
  'use strict'
  if (window.SignalcraftForms) { window.SignalcraftForms.scan(); return }
  var me = document.currentScript || document.querySelector('script[src*="/embed/forms.js"]')
  var BASE = me ? new URL(me.src, location.href).origin : ''
  var ls = { get: function (k) { try { return localStorage.getItem(k) } catch (e) { return null } }, set: function (k, v) { try { localStorage.setItem(k, v) } catch (e) { /* private mode */ } } }
  var frames = {}
  var seq = 0
  var openEl = null
  var lastFocus = null
  var configs = {}

  var css = '.scf-frame{width:100%;border:0;display:block;min-height:120px;background:transparent;color-scheme:normal}' +
    '.scf-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px;animation:scf-in .18s ease-out}' +
    '.scf-panel{position:relative;background:#fff;border-radius:14px;width:100%;max-width:560px;max-height:calc(100vh - 32px);overflow:auto;box-shadow:0 20px 60px rgba(15,23,42,.35);padding:12px}' +
    '.scf-slide{position:fixed;z-index:2147483000;bottom:16px;width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 96px);overflow:auto;background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(15,23,42,.3);padding:12px;animation:scf-up .2s ease-out}' +
    '.scf-right{right:16px}.scf-left{left:16px}' +
    '.scf-close{position:absolute;top:6px;right:6px;width:36px;height:36px;border:0;border-radius:50%;background:rgba(15,23,42,.06);color:#0f172a;font:20px/36px system-ui,sans-serif;cursor:pointer;z-index:1}' +
    '.scf-close:focus-visible{outline:3px solid #6366f1;outline-offset:2px}' +
    '.scf-fab{position:fixed;z-index:2147482999;bottom:16px;border:0;border-radius:999px;padding:12px 20px;font:600 15px/1.2 system-ui,sans-serif;color:#fff;background:#4f46e5;box-shadow:0 8px 24px rgba(15,23,42,.25);cursor:pointer}' +
    '@keyframes scf-in{from{opacity:0}to{opacity:1}}@keyframes scf-up{from{transform:translateY(16px);opacity:0}to{transform:none;opacity:1}}' +
    '@media (prefers-reduced-motion:reduce){.scf-overlay,.scf-slide{animation:none}}'
  var style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)

  function frameSrc(id, mode, host) {
    var p = new URLSearchParams()
    var iid = 'f' + ++seq
    p.set('iid', iid)
    p.set('mode', mode)
    p.set('page', location.href.slice(0, 1500))
    if (document.referrer) p.set('ref', document.referrer.slice(0, 1000))
    var q = new URLSearchParams(location.search)
    ;['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(function (k) { if (q.get(k)) p.set(k, q.get(k)) })
    try { var fam = getComputedStyle(host || document.body).fontFamily; if (fam) p.set('font', fam.slice(0, 200)) } catch (e) { /* ignore */ }
    return { iid: iid, src: BASE + '/embed/form/' + encodeURIComponent(id) + '?' + p.toString() }
  }
  function makeFrame(id, mode, host) {
    var s = frameSrc(id, mode, host)
    var f = document.createElement('iframe')
    f.className = 'scf-frame'
    f.src = s.src
    f.title = 'Form'
    f.setAttribute('loading', mode === 'inline' ? 'lazy' : 'eager')
    f.setAttribute('scrolling', 'no')
    f.style.height = '360px'
    frames[s.iid] = { frame: f, id: id, mode: mode }
    return f
  }

  function mountInline(el) {
    if (el.getAttribute('data-scf-mounted')) return
    var id = el.getAttribute('data-signalcraft-inline')
    if (!id) return
    el.setAttribute('data-scf-mounted', '1')
    el.appendChild(makeFrame(id, 'inline', el))
  }

  function close() {
    if (!openEl) return
    openEl.remove()
    openEl = null
    document.removeEventListener('keydown', onKey, true)
    if (lastFocus && lastFocus.focus) lastFocus.focus()
  }
  function onKey(e) { if (e.key === 'Escape') close() }
  function open(id, mode, position) {
    if (openEl) close()
    lastFocus = document.activeElement
    var frame = makeFrame(id, mode, document.body)
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'scf-close'
    btn.setAttribute('aria-label', 'Close')
    btn.innerHTML = '&times;'
    btn.addEventListener('click', close)
    var panel = document.createElement('div')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'Form')
    if (mode === 'popup') {
      var overlay = document.createElement('div')
      overlay.className = 'scf-overlay'
      panel.className = 'scf-panel'
      panel.setAttribute('aria-modal', 'true')
      overlay.appendChild(panel)
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close() })
      openEl = overlay
    } else {
      panel.className = 'scf-slide ' + (position === 'bottom_left' ? 'scf-left' : 'scf-right')
      openEl = panel
    }
    panel.appendChild(btn)
    panel.appendChild(frame)
    document.body.appendChild(openEl)
    document.addEventListener('keydown', onKey, true)
    btn.focus()
    ls.set('scf_seen_' + id, String(Date.now()))
  }

  function isMobile() { return window.matchMedia && window.matchMedia('(max-width: 767px)').matches }
  function allowed(id, d) {
    if (d.devices === 'desktop' && isMobile()) return false
    if (d.devices === 'mobile' && !isMobile()) return false
    if (d.hide_after_submit && ls.get('scf_done_' + id)) return false
    var seen = Number(ls.get('scf_seen_' + id) || 0)
    if (seen && d.frequency === 'once') return false
    if (seen && d.frequency === 'days' && Date.now() - seen < d.frequency_days * 864e5) return false
    return true
  }
  function setupPopup(id, modeOverride) {
    if (configs[id]) return
    configs[id] = 'loading'
    fetch(BASE + '/api/v1/public/forms/' + encodeURIComponent(id), { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (c) {
        if (!c) return
        configs[id] = c
        var d = c.display
        var mode = modeOverride || d.mode
        if (mode === 'inline') mode = 'popup'
        if (mode === 'floating') {
          if (d.hide_after_submit && ls.get('scf_done_' + id)) return
          var fab = document.createElement('button')
          fab.type = 'button'
          fab.className = 'scf-fab'
          fab.style[d.position === 'bottom_left' ? 'left' : 'right'] = '16px'
          if (c.button_color) { fab.style.background = c.button_color; fab.style.color = c.button_text_color || '#fff' }
          fab.textContent = d.button_label || 'Contact us'
          fab.addEventListener('click', function () { open(id, 'slide_in', d.position) })
          document.body.appendChild(fab)
          return
        }
        if (d.trigger === 'click' || !allowed(id, d)) return
        var fired = false
        function fire() { if (fired || openEl) return; fired = true; open(id, mode, d.position) }
        if (d.trigger === 'load') setTimeout(fire, (d.delay_seconds || 0) * 1000)
        else if (d.trigger === 'scroll') {
          var onScroll = function () {
            var h = document.documentElement.scrollHeight - window.innerHeight
            if (h <= 0 || (window.scrollY / h) * 100 >= d.scroll_percent) { window.removeEventListener('scroll', onScroll); fire() }
          }
          window.addEventListener('scroll', onScroll, { passive: true })
          onScroll()
        } else if (d.trigger === 'exit') {
          if (isMobile()) return
          document.addEventListener('mouseout', function (e) { if (!e.relatedTarget && e.clientY <= 0) fire() })
        }
      })
      .catch(function () { configs[id] = null })
  }

  function scan() {
    document.querySelectorAll('[data-signalcraft-inline]').forEach(mountInline)
    document.querySelectorAll('[data-signalcraft-popup]').forEach(function (el) {
      if (el.getAttribute('data-scf-mounted')) return
      el.setAttribute('data-scf-mounted', '1')
      setupPopup(el.getAttribute('data-signalcraft-popup'), el.getAttribute('data-mode'))
    })
  }

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-signalcraft-form]') : null
    if (!t) return
    e.preventDefault()
    open(t.getAttribute('data-signalcraft-form'), t.getAttribute('data-mode') === 'slide_in' ? 'slide_in' : 'popup')
  })

  window.addEventListener('message', function (e) {
    if (e.origin !== BASE) return
    var d = e.data
    if (!d || d.source !== 'signalcraft-form' || !frames[d.iid]) return
    var inst = frames[d.iid]
    if (d.type === 'resize' && d.height > 0) inst.frame.style.height = Math.min(d.height, 5000) + 'px'
    else if (d.type === 'submitted') ls.set('scf_done_' + inst.id, '1')
    else if (d.type === 'redirect' && typeof d.url === 'string' && /^https?:\/\//i.test(d.url)) location.href = d.url
  })

  if (window.MutationObserver) {
    var timer = null
    new MutationObserver(function () { clearTimeout(timer); timer = setTimeout(scan, 50) }).observe(document.documentElement, { childList: true, subtree: true })
  }
  window.SignalcraftForms = { scan: scan, open: function (id, mode) { open(id, mode || 'popup') }, close: close }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan)
  else scan()
})()
