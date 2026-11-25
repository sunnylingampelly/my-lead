/* Signalcraft lead form runtime (iframe and hosted page). Vanilla JS, no dependencies. */
(function () {
  'use strict'
  var cfgEl = document.getElementById('sc-config')
  var form = document.getElementById('sc-form')
  if (!cfgEl || !form) return
  var cfg = JSON.parse(cfgEl.textContent || '{}')
  var qs = new URLSearchParams(location.search)
  var inFrame = window.parent !== window
  var pageUrl = cfg.hosted ? location.href : qs.get('page') || ''
  var referrer = cfg.hosted ? document.referrer : qs.get('ref') || ''
  var pageParams
  try { pageParams = new URL(pageUrl).searchParams } catch (e) { pageParams = new URLSearchParams() }
  var UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']
  var utm = {}
  UTM.forEach(function (k) { var v = qs.get(k) || pageParams.get(k); if (v) utm[k] = v.slice(0, 200) })
  var targetOrigin = '*'
  try { if (pageUrl) targetOrigin = new URL(pageUrl).origin } catch (e) { /* keep * */ }
  var byId = {}
  cfg.fields.forEach(function (f) { byId[f.id] = f })
  var step = 0
  var clientId = null
  var started = false
  var busy = false

  function post(type, extra) {
    if (!inFrame) return
    var msg = { source: 'signalcraft-form', iid: cfg.iid, id: cfg.public_id, type: type }
    for (var k in extra || {}) msg[k] = extra[k]
    try { window.parent.postMessage(msg, targetOrigin) } catch (e) { /* ignore */ }
  }
  function api(path, body) {
    return fetch(cfg.api + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit' })
  }
  function wrap(id) { return form.querySelector('[data-field="' + id + '"]') }
  function inputs(id) { return form.querySelectorAll('[name="' + id + '"]') }

  // Hidden fields: fixed, URL parameter, page URL, referrer, UTM.
  cfg.fields.forEach(function (f) {
    if (f.type !== 'hidden' || !f.hidden) return
    var el = document.getElementById('f_' + f.id)
    if (!el) return
    var h = f.hidden
    if (h.kind === 'url_param') el.value = (pageParams.get(h.value) || qs.get(h.value) || '').slice(0, 500)
    else if (h.kind === 'page_url') el.value = pageUrl.slice(0, 500)
    else if (h.kind === 'referrer') el.value = referrer.slice(0, 500)
    else if (UTM.indexOf(h.kind) >= 0) el.value = utm[h.kind] || ''
  })

  function value(f) {
    var els = inputs(f.id)
    if (!els.length) return null
    if (f.type === 'checkboxes') { var out = []; els.forEach(function (e) { if (e.checked) out.push(e.value) }); return out }
    if (f.type === 'radio') { var v = null; els.forEach(function (e) { if (e.checked) v = e.value }); return v }
    if (f.type === 'consent') return els[0].checked
    if (f.type === 'phone') {
      var cc = document.getElementById('c_' + f.id)
      var n = els[0].value.trim()
      return n ? { country: cc ? cc.value : '', number: n } : null
    }
    return els[0].value.trim()
  }
  function answers() {
    var out = {}
    cfg.fields.forEach(function (f) { var v = value(f); if (v !== null && v !== '' && !(Array.isArray(v) && !v.length) && v !== false) out[f.id] = v })
    return out
  }
  function matches(c, vals) {
    var v = vals[c.field]
    var want = (c.value || '').trim().toLowerCase()
    var items = Array.isArray(v) ? v.map(function (x) { return String(x).trim().toLowerCase() }) : v === true ? ['true', 'yes'] : v === undefined || v === null || v === '' || v === false ? [] : [String(typeof v === 'object' ? v.number : v).trim().toLowerCase()]
    if (c.op === 'is_set') return items.length > 0
    if (c.op === 'is_not_set') return items.length === 0
    if (c.op === 'not_equals') return items.indexOf(want) < 0
    if (c.op === 'contains') return items.some(function (i) { return i.indexOf(want) >= 0 })
    return items.indexOf(want) >= 0
  }
  function visible(f, vals, depth) {
    if (!f.condition || !byId[f.condition.field] || depth > 20) return true
    return visible(byId[f.condition.field], vals, depth + 1) && matches(f.condition, vals)
  }
  function applyConditions() {
    var vals = answers()
    cfg.fields.forEach(function (f) {
      var w = wrap(f.id)
      var show = visible(f, vals, 0)
      if (w) w.hidden = !show
      inputs(f.id).forEach(function (el) { el.disabled = !show })
      if (f.type === 'phone') { var cc = document.getElementById('c_' + f.id); if (cc) cc.disabled = !show }
    })
    resize()
  }

  function setError(f, msg) {
    var err = document.getElementById('e_' + f.id)
    if (err) err.textContent = msg || ''
    inputs(f.id).forEach(function (el) { if (msg) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid') })
  }
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
  function check(f) {
    var w = wrap(f.id)
    if (f.type === 'hidden' || (w && w.hidden)) return ''
    var v = value(f)
    var empty = v === null || v === '' || v === false || (Array.isArray(v) && !v.length)
    if (empty) return f.required ? (f.type === 'consent' ? 'Please tick this box to continue' : 'This field is required') : ''
    if (f.type === 'email' && !EMAIL.test(v)) return 'Enter a valid email address'
    if (f.type === 'phone') { var d = v.number.replace(/\D/g, ''); if (d.length < 6 || d.length > 15) return 'Enter a valid phone number' }
    if (f.type === 'number') {
      var n = Number(String(v).replace(/,/g, ''))
      if (isNaN(n)) return 'Enter a number'
      if (f.min !== null && f.min !== undefined && n < f.min) return 'Must be at least ' + f.min
      if (f.max !== null && f.max !== undefined && n > f.max) return 'Must be at most ' + f.max
    }
    return ''
  }
  function validate(onlyStep) {
    var bad = []
    cfg.fields.forEach(function (f) {
      if (onlyStep !== undefined && f.step !== onlyStep) return
      var msg = check(f)
      setError(f, msg)
      if (msg) bad.push(f)
    })
    summary(bad.length ? (bad.length === 1 ? 'Please fix the highlighted field.' : 'Please fix the ' + bad.length + ' highlighted fields.') : '')
    if (bad.length) focusField(bad[0])
    return !bad.length
  }
  function focusField(f) {
    var el = document.getElementById('f_' + f.id) || document.getElementById('f_' + f.id + '_0')
    if (el && el.focus) el.focus()
  }
  function summary(msg) { document.getElementById('sc-summary').textContent = msg; resize() }
  function status(msg) { document.getElementById('sc-status').textContent = msg; resize() }

  // Steps.
  var back = form.querySelector('.sc-back')
  var next = form.querySelector('.sc-next')
  var submitBtn = form.querySelector('.sc-submit')
  function showStep(i, focus) {
    step = i
    form.querySelectorAll('.sc-step').forEach(function (s) { s.hidden = Number(s.getAttribute('data-step-index')) !== i })
    if (cfg.steps > 1) {
      back.hidden = i === 0
      next.hidden = i === cfg.steps - 1
      submitBtn.hidden = i !== cfg.steps - 1
      var bar = form.querySelector('.sc-progress-bar')
      if (bar) bar.style.width = Math.round(((i + 1) / cfg.steps) * 100) + '%'
      var p = form.querySelector('.sc-progress')
      if (p) p.setAttribute('aria-valuenow', String(i + 1))
      var label = form.querySelector('.sc-progress-label')
      if (label) label.textContent = 'Step ' + (i + 1) + ' of ' + cfg.steps
      if (focus) {
        var first = form.querySelector('.sc-step:not([hidden]) .sc-field:not([hidden]) input, .sc-step:not([hidden]) .sc-field:not([hidden]) select, .sc-step:not([hidden]) .sc-field:not([hidden]) textarea')
        if (first) first.focus()
      }
    }
    resize()
  }
  if (next) next.addEventListener('click', function () { if (validate(step)) showStep(step + 1, true) })
  if (back) back.addEventListener('click', function () { summary(''); showStep(step - 1, true) })

  function markStarted() {
    if (started) return
    started = true
    api('/event', { type: 'start' }).catch(function () {})
    post('start')
  }
  form.addEventListener('input', function (ev) { markStarted(); applyConditions(); var f = byId[(ev.target.name || '')]; if (f && ev.target.getAttribute('aria-invalid')) setError(f, check(f)) })
  form.addEventListener('change', function () { markStarted(); applyConditions() })
  form.addEventListener('focusin', markStarted)

  function randomId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '')
    var s = ''
    for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16)
    return s
  }
  function safeUrl(u) { return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null }
  function done(res) {
    post('submitted', { redirect: safeUrl(res.redirect_url) || null })
    var url = safeUrl(res.redirect_url)
    var succ = document.querySelector('[data-sc-success]')
    if (res.mode !== 'redirect' || !url) {
      form.hidden = true
      succ.hidden = false
      if (res.pending_confirmation) {
        var p = document.createElement('p')
        p.textContent = 'Please check your inbox and click the link to confirm.'
        succ.insertBefore(p, succ.firstChild ? succ.firstChild.nextSibling : null)
      }
      succ.focus()
    }
    resize()
    if (url) {
      setTimeout(function () {
        if (inFrame) post('redirect', { url: url })
        else location.href = url
      }, (res.mode === 'both' ? res.redirect_delay || 0 : 0) * 1000)
    }
  }
  form.addEventListener('submit', function (ev) {
    ev.preventDefault()
    if (busy) return
    if (!validate()) {
      // Jump to the first step with an error.
      var firstBad = cfg.fields.filter(function (f) { return check(f) })[0]
      if (firstBad && firstBad.step !== step) { showStep(firstBad.step); validate(firstBad.step) }
      return
    }
    busy = true
    submitBtn.disabled = true
    status('Sending…')
    clientId = clientId || randomId()
    var ts = form.querySelector('[name="cf-turnstile-response"]')
    api('/submit', {
      client_id: clientId, values: answers(), render_token: cfg.token, hp: document.getElementById('sc_website').value,
      page_url: pageUrl || null, referrer: referrer || null, utm: utm, turnstile_token: ts ? ts.value : null
    }).then(function (r) {
      return r.json().catch(function () { return {} }).then(function (body) { return { ok: r.ok, status: r.status, body: body } })
    }).then(function (r) {
      busy = false
      submitBtn.disabled = false
      status('')
      if (r.ok) { done(r.body); return }
      var err = (r.body && r.body.error) || {}
      if (err.code === 'INVALID_FIELDS' && err.details && err.details.fields) {
        var bad = []
        cfg.fields.forEach(function (f) { var m = err.details.fields[f.id]; setError(f, m || ''); if (m) bad.push(f) })
        if (bad.length) { if (bad[0].step !== step) showStep(bad[0].step); focusField(bad[0]) }
        summary(err.message || 'Please check the highlighted fields.')
      } else {
        summary(err.message || (r.status === 429 ? 'Too many attempts. Please wait a minute and try again.' : 'Something went wrong. Please try again.'))
      }
    }).catch(function () {
      busy = false
      submitBtn.disabled = false
      status('')
      summary('We couldn’t reach the server. Check your connection and try again.')
    })
  })

  // Size reporting for the loader.
  var lastH = 0
  function resize() {
    if (!inFrame) return
    var h = Math.ceil(document.documentElement.getBoundingClientRect().height)
    if (h !== lastH) { lastH = h; post('resize', { height: h }) }
  }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(document.body)
  window.addEventListener('load', resize)

  applyConditions()
  showStep(0)
  api('/event', { type: 'view' }).catch(function () {})
  post('ready')
})()
