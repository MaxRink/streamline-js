(function () {
  "use strict";
  var q = new URLSearchParams(location.search), root = document.documentElement;
  var lang = (q.get("lang") || "en").toLowerCase().split("-")[0];
  var strings = {de: {Back: "Zurück", Next: "Weiter", Done: "Fertig", Show: "Anzeigen", Hide: "Verbergen", "Step {n} of {m}": "Schritt {n} von {m}"}};
  var embedded = q.get("embed") === "1", fit = false;
  var parentPost = function (msg) { if (window.parent !== window) window.parent.postMessage(msg, "*"); };
  var pu = {
    lang: lang, embedded: embedded, params: q,
    t: function (key, vars) {
      var s = (strings[lang] && strings[lang][key]) || key;
      return s.replace(/\{(\w+)\}/g, function (_, k) { return vars && k in vars ? vars[k] : "{" + k + "}"; });
    },
    init: function (opts) {
      opts = opts || {};
      Object.keys(opts.strings || {}).forEach(function (l) { strings[l] = Object.assign(strings[l] || {}, opts.strings[l]); });
      document.querySelectorAll("[data-pu-t]").forEach(function (el) { el.textContent = pu.t(el.getAttribute("data-pu-t")); });
      fit = Boolean(opts.fit) && embedded;
      parentPost({type: "streamline:ready"});
      if (fit) { pu.size(); if (window.ResizeObserver) new ResizeObserver(pu.size).observe(document.querySelector(".pu-page") || document.body); }
    },
    size: function () {
      if (!fit) return;
      var r = (document.querySelector(".pu-page") || document.body).getBoundingClientRect();
      parentPost({type: "streamline:size", width: Math.ceil(r.width), height: Math.ceil(r.height)});
    },
    done: async function () {
      if (window.parent !== window) return parentPost({type: "streamline:close"});
      var bridge = window.flutter_inappwebview;
      if (bridge && bridge.callHandler) return bridge.callHandler("pluginSurface", {type: "close"});
      var target = q.get("returnTo"), skin = null, path = q.get("return");
      try {
        if (!target && path && /^\/(?![\/\\])/.test(path)) {
          var s = await (await fetch("/api/v1/webui/server/status")).json();
          if (s.serving && Number.isInteger(s.port)) { skin = new URL(location.href); skin.port = String(s.port); target = new URL(path, skin.origin).href; }
        }
        if (target) {
          var u = new URL(target);
          if (/^https?:$/.test(u.protocol) && u.hostname === location.hostname && !u.username && !u.password && (!skin || u.origin === skin.origin)) return location.assign(u.href);
        }
      } catch (e) { target = null; }
      history.back();
    },
    api: async function (path, opts) {
      opts = opts || {};
      var res = await fetch(path, {method: opts.method || (opts.body === undefined ? "GET" : "POST"),
        headers: opts.body === undefined ? {} : {"Content-Type": "application/json"},
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body)});
      var data = null; try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok) { var err = new Error((data && data.error) || "HTTP " + res.status); err.status = res.status; err.data = data; throw err; }
      return data;
    },
    secureValue: function (input, wasSet) {
      if (input.value) return input.value;
      return wasSet ? {isSet: true} : undefined;
    },
    fingerprint: function (hex) {
      return String(hex).replace(/[^0-9a-f]/gi, "").toUpperCase().replace(/(..)(?!$)/g, "$1:");
    },
    wizard: function (container, onNext) {
      var steps = Array.prototype.slice.call(container.querySelectorAll("[data-pu-step]")), i = 0;
      var back = container.querySelector("[data-pu-back]"), next = container.querySelector("[data-pu-next]"), bar = container.querySelector("[data-pu-stepper]");
      function show(n) {
        i = n;
        steps.forEach(function (s, k) { s.hidden = k !== i; });
        if (back) back.disabled = i === 0;
        if (next) next.hidden = i === steps.length - 1;
        if (bar) bar.innerHTML = steps.map(function (_, k) { return "<i class=\"" + (k <= i ? "on" : "") + "\"></i>"; }).join("") + "<span></span>";
        if (bar) bar.lastChild.textContent = pu.t("Step {n} of {m}", {n: i + 1, m: steps.length});
        var h = steps[i].querySelector("h2"); if (h) { h.tabIndex = -1; h.focus(); }
        pu.size();
      }
      if (back) back.addEventListener("click", function () { if (i > 0) show(i - 1); });
      if (next) next.addEventListener("click", async function () {
        next.disabled = true;
        try { if (!onNext || (await onNext(i, steps[i])) !== false) show(Math.min(i + 1, steps.length - 1)); } finally { next.disabled = false; }
      });
      show(0);
      return {show: show, get index() { return i; }};
    }
  };
  var theme = q.get("theme");
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  if (embedded) root.setAttribute("data-embed", "");
  root.lang = lang;
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-pu-reveal]");
    if (b) {
      var input = b.parentNode.querySelector("input");
      var hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      b.textContent = pu.t(hidden ? "Hide" : "Show");
      b.setAttribute("aria-pressed", String(hidden));
    }
    if (e.target.closest && e.target.closest("[data-pu-done]")) pu.done();
  });
  window.pu = pu;
})();
