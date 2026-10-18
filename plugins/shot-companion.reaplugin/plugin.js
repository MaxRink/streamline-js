/* shot-companion.reaplugin
 *
 * Adds three things to the Streamline dashboard through its plugin surfaces
 * (docs/plugin-surfaces.md in streamline-js):
 *
 * - The current bean in the top bar. Tapping it opens a small read-only card
 *   over the dashboard: roaster, roast date and days off roast, beans left, how
 *   many shots used this coffee and the last of them.
 * - A live shot strip that replaces the info row (Water, Steam, Tank, Clock,
 *   Weight) while an espresso runs: weight against the Drink target, pressure
 *   and flow against the profile, the current step, and today's shot number.
 *   The skin draws the numbers from its own snapshot stream; this plugin only
 *   chooses the cells.
 * - Last-shot pills under Grind, Dose and Drink, recalled from the last
 *   matching shot (same profile, same coffee or any shot). Tapping a pill sets
 *   that value through the skin's own setter. A line under Drink shows what the
 *   last shot actually produced.
 *
 * The plugin never writes the workflow and never commands the machine.
 */

function createPlugin(host) {
  "use strict";

  const ID = "shot-companion.reaplugin";
  const BASE = "http://localhost:8080/api/v1";
  const TODAY_PAGE = 100;
  const MATCH = { profile: "Same profile", coffee: "Same coffee", any: "Any shot" };

  let generation = 0;
  let settings = { liveStrip: true, pills: true, beanButton: true, matchBy: MATCH.profile };
  let workflow = null;
  let batch = null;       // { id, roastDate, roastLevel, weightRemaining } of the workflow's bean batch
  let last = null;        // the recalled shot, see summarizeShot()
  let lastKey = null;     // the match key `last` was looked up for
  let today = null;       // { day: "YYYY-M-D", count, capped }
  let durationCache = {}; // shot id -> seconds (or null)
  let lastServed = null;  // the skin answer the skin last read, as JSON
  let refreshing = null;
  let refreshAgain = false;

  function log(msg) {
    host.log(`[shot-companion] ${msg}`);
  }

  // ── Small pure helpers ─────────────────────────────────────────────────────

  function toBool(value, fallback) {
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    return fallback;
  }

  function finite(value) {
    const n = typeof value === "number" ? value
      : (typeof value === "string" && value.trim() !== "" ? Number(value) : NaN);
    return Number.isFinite(n) ? n : null;
  }

  function fmt(n, decimals) {
    const f = Math.pow(10, decimals);
    return String(Math.round(n * f) / f);
  }

  // Decaid timestamps come with or without a zone and with up to microsecond
  // precision; Date.parse varies across JS engines on both, so parse by hand.
  // A time without a zone is local, as the shot was recorded on this device.
  function parseTime(value) {
    if (typeof value !== "string") return null;
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/);
    if (!m) return null;
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
    const ms = m[7] ? Number((m[7] + "00").slice(0, 3)) : 0;
    if (!m[8]) return new Date(y, mo - 1, d, h, mi, s, ms).getTime();
    let offsetMin = 0;
    if (m[8] !== "Z") {
      const sign = m[8][0] === "-" ? -1 : 1;
      const digits = m[8].slice(1).replace(":", "");
      offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    }
    return Date.UTC(y, mo - 1, d, h, mi, s, ms) - offsetMin * 60000;
  }

  function shotTime(shot) {
    return parseTime(shot && shot.createdAt) ?? parseTime(shot && shot.timestamp);
  }

  function localDay(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function ago(ms, now) {
    const mins = Math.floor((now - ms) / 60000);
    if (!Number.isFinite(mins) || mins < 1) return "just now";
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.floor(hours / 24);
    return days === 1 ? "yesterday" : `${days} days ago`;
  }

  // The fields the pills and line need, with the same fallbacks the skin's
  // history uses for older shot records (doseData, grinderData).
  function summarizeShot(shot) {
    const wf = (shot && shot.workflow) || {};
    const ctx = wf.context || {};
    const ann = shot.annotations || {};
    return {
      id: shot.id,
      at: shotTime(shot),
      profile: (wf.profile && typeof wf.profile.title === "string") ? wf.profile.title : "",
      grind: finite(ctx.grinderSetting ?? (wf.grinderData && wf.grinderData.setting)),
      dose: finite(ann.actualDoseWeight ?? ctx.targetDoseWeight ?? (wf.doseData && wf.doseData.doseIn)),
      yieldTarget: finite(ctx.targetYield ?? (wf.doseData && wf.doseData.doseOut)),
      yieldActual: finite(ann.actualYield),
    };
  }

  // Seconds from the end of shot preparation to the last sample, as the skin's
  // shot summary counts them.
  function shotDuration(measurements) {
    if (!Array.isArray(measurements) || measurements.length === 0) return null;
    let start = measurements.findIndex(m => m && m.machine && m.machine.state
      && m.machine.state.substate !== "preparingForShot");
    if (start < 0) start = 0;
    const t0 = parseTime(measurements[start].machine && measurements[start].machine.timestamp);
    const end = measurements[measurements.length - 1];
    const t1 = parseTime(end && end.machine && end.machine.timestamp);
    if (t0 === null || t1 === null || t1 < t0) return null;
    return Math.round((t1 - t0) / 1000);
  }

  function text(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  // The coffee on the workflow, from the context or the older coffeeData shape.
  function currentBean(wf) {
    const ctx = (wf && wf.context) || {};
    const legacy = (wf && wf.coffeeData) || {};
    const name = text(ctx.coffeeName) || text(legacy.name);
    if (!name) return null;
    return { name, roaster: text(ctx.coffeeRoaster) || text(legacy.roaster), batchId: text(ctx.beanBatchId) };
  }

  function daysOffRoast(roastDate, now) {
    const at = parseTime(roastDate) ?? parseTime(`${roastDate}T00:00:00`);
    if (at === null || at > now) return null;
    const midnight = ms => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
    return Math.round((midnight(now) - midnight(at)) / 86400000);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Which earlier shot to recall for the current workflow: a query filter and a
  // short label for the pill titles.
  function matchFor(wf) {
    const title = wf && wf.profile && typeof wf.profile.title === "string" ? wf.profile.title.trim() : "";
    const bean = currentBean(wf);
    const coffee = bean ? bean.name : "";
    if (settings.matchBy === MATCH.any) return { key: "any", query: "", label: "Last shot" };
    if (settings.matchBy === MATCH.coffee && coffee) {
      return { key: `coffee:${coffee}`, query: `&coffeeName=${encodeURIComponent(coffee)}`, label: `Last ${coffee} shot` };
    }
    if (title) return { key: `profile:${title}`, query: `&profileTitle=${encodeURIComponent(title)}`, label: `Last ${title} shot` };
    return null;
  }

  // ── The skin answer ────────────────────────────────────────────────────────

  function stripSurface() {
    const cells = [
      { cell: "weight", col: 1, span: 2, bar: true },
      { cell: "pressure", col: 3, span: 2, dot: { greenWithin: 0.1, amberWithin: 0.25 } },
      { cell: "flow", col: 5, span: 2, color: "flow", dot: { greenWithin: 0.1, amberWithin: 0.25 } },
    ];
    if (today) {
      const n = today.count + 1;
      cells.push({ cell: "step", col: 7, span: 2 });
      cells.push({ label: "Today", text: today.capped ? `#${n}+` : `#${n}`, color: "accent", col: 9, span: 1 });
    } else {
      cells.push({ cell: "step", col: 7, span: 3 });
    }
    return { id: "strip", kind: "shot-strip", show: "shot", cells };
  }

  function pillSurfaces(now) {
    if (!last) return [];
    const match = matchFor(workflow);
    const title = cut(`${match ? match.label : "Last shot"}, ${last.at === null ? "earlier" : ago(last.at, now)}`, 80);
    const ctx = (workflow && workflow.context) || {};
    const out = [];

    const same = (a, b) => a !== null && b !== null && Math.abs(a - b) < 0.005;
    const pill = (id, tile, field, value, decimals, unit, lo, hi, current) => {
      if (value === null || value < lo || value > hi) return;
      out.push({
        id, kind: "tile-hint", tile, text: `Last ${fmt(value, decimals)}${unit}`, title,
        ...(same(value, current) && { active: true }),
        action: { type: "set", field, value },
      });
    };
    pill("last-grind", "grind", "grinderSetting", last.grind, 2, "", 0, 9999, finite(ctx.grinderSetting));
    pill("last-dose", "dose", "targetDoseWeight", last.dose, 1, "g", 1, 30, finite(ctx.targetDoseWeight));
    pill("last-yield", "drink", "targetYield", last.yieldTarget, 1, "g", 1, 2000, finite(ctx.targetYield));

    const result = [];
    if (last.yieldActual !== null && last.yieldActual > 0) result.push(`${fmt(last.yieldActual, 1)}g`);
    const secs = durationCache[last.id];
    if (Number.isFinite(secs) && secs > 0) result.push(`${secs}s`);
    if (result.length) out.push({ id: "last-result", kind: "tile-line", tile: "drink", text: result.join(" · ") });
    return out;
  }

  function cut(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  function beanSurface(now) {
    const bean = currentBean(workflow);
    if (!bean) return null;
    const details = [];
    if (bean.roaster) details.push(bean.roaster);
    const days = batch && batch.id === bean.batchId && batch.roastDate ? daysOffRoast(batch.roastDate, now) : null;
    if (days !== null) details.push(days === 1 ? "1 day off roast" : `${days} days off roast`);
    return {
      id: "bean", kind: "header-button", label: cut(bean.name, 24),
      ...(details.length && { text: cut(details.join(" · "), 40) }),
      action: { type: "open", view: "bean", presentation: "overlay", fit: true, closeOnShot: true },
    };
  }

  function skinAnswer(now) {
    const surfaces = [];
    const bean = settings.beanButton ? beanSurface(now) : null;
    if (bean) surfaces.push(bean);
    if (settings.liveStrip) surfaces.push(stripSurface());
    if (settings.pills) surfaces.push(...pillSurfaces(now));
    return { version: 1, surfaces, live: { endpoint: "changed" } };
  }

  // Tell the skin to read `skin` again, only when the answer really changed.
  // Titles carry a relative age, which the minute poll refreshes on its own.
  function answerKey(answer) {
    return JSON.stringify(answer.surfaces.map(s => ({ ...s, title: undefined })));
  }

  function pushIfChanged() {
    const key = answerKey(skinAnswer(Date.now()));
    if (lastServed !== null && key === lastServed) return;
    lastServed = key;
    try {
      host.emit("changed", { what: "skin" });
    } catch (e) {
      log(`emit failed: ${e && e.message}`);
    }
  }

  // ── Reading Decaid ─────────────────────────────────────────────────────────

  function rememberDuration(id, secs) {
    const keep = Object.keys(durationCache).slice(-7);
    const next = {};
    for (const k of keep) next[k] = durationCache[k];
    next[id] = secs;
    durationCache = next;
  }

  async function getJson(path) {
    const res = await fetch(BASE + path);
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return res.json();
  }

  async function loadWorkflow() {
    try {
      workflow = await getJson("/workflow");
    } catch (e) {
      log(`could not read the workflow: ${e && e.message}`);
    }
  }

  async function loadLastShot(gen) {
    const match = matchFor(workflow);
    if (!match) {
      last = null;
      lastKey = null;
      return;
    }
    const page = await getJson(`/shots?limit=1&offset=0&orderBy=timestamp&order=desc${match.query}`);
    if (gen !== generation) return;
    const item = page && Array.isArray(page.items) ? page.items[0] : null;
    last = item ? summarizeShot(item) : null;
    lastKey = match.key;
    if (last && !Object.prototype.hasOwnProperty.call(durationCache, last.id)) {
      try {
        const full = await getJson(`/shots/${encodeURIComponent(last.id)}`);
        if (gen !== generation) return;
        rememberDuration(last.id, shotDuration(full && full.measurements));
      } catch (e) {
        rememberDuration(last.id, null);
        log(`could not read shot ${last.id}: ${e && e.message}`);
      }
    }
  }

  async function loadBatch(gen) {
    const bean = currentBean(workflow);
    if (!bean || !bean.batchId) {
      batch = null;
      return;
    }
    const b = await getJson(`/bean-batches/${encodeURIComponent(bean.batchId)}`);
    if (gen !== generation) return;
    batch = {
      id: bean.batchId,
      roastDate: text(b && b.roastDate),
      roastLevel: text(b && b.roastLevel),
      weightRemaining: finite(b && b.weightRemaining),
    };
  }

  async function countToday(gen) {
    const now = Date.now();
    const day = localDay(now);
    const page = await getJson(`/shots?limit=${TODAY_PAGE}&offset=0&orderBy=timestamp&order=desc`);
    if (gen !== generation) return;
    const items = page && Array.isArray(page.items) ? page.items : [];
    let count = 0;
    for (const shot of items) {
      const at = shotTime(shot);
      if (at === null) continue;
      if (localDay(at) !== day) break;
      count += 1;
    }
    today = { day, count, capped: count === items.length && items.length === TODAY_PAGE };
  }

  // One refresh at a time; a request during one runs once more afterwards.
  function refresh({ shots = true } = {}) {
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    const gen = generation;
    refreshing = (async () => {
      try {
        if (settings.pills) await loadLastShot(gen);
      } catch (e) {
        log(`could not read the last shot: ${e && e.message}`);
      }
      try {
        if (settings.beanButton) await loadBatch(gen);
      } catch (e) {
        batch = null;
        log(`could not read the bean batch: ${e && e.message}`);
      }
      try {
        if (settings.liveStrip && shots) await countToday(gen);
      } catch (e) {
        log(`could not count today's shots: ${e && e.message}`);
      }
      if (gen === generation) pushIfChanged();
    })().finally(() => {
      refreshing = null;
      if (refreshAgain && gen === generation) {
        refreshAgain = false;
        refresh();
      }
    });
    return refreshing;
  }

  function onWorkflow(next) {
    if (!next || typeof next !== "object") return;
    workflow = next;
    const match = matchFor(workflow);
    const bean = currentBean(workflow);
    const batchMoved = settings.beanButton && (bean && bean.batchId ? bean.batchId : null) !== (batch ? batch.id : null);
    if ((settings.pills && (match ? match.key : null) !== lastKey) || batchMoved) refresh({ shots: false });
    else pushIfChanged();
  }

  // ── The bean card (the header button's overlay) ────────────────────────────

  async function beanCardData(bean) {
    const page = await getJson(`/shots?limit=1&offset=0&orderBy=timestamp&order=desc&coffeeName=${encodeURIComponent(bean.name)}`);
    const item = page && Array.isArray(page.items) ? page.items[0] : null;
    return { total: page && Number.isInteger(page.total) ? page.total : null, lastShot: item ? summarizeShot(item) : null };
  }

  function beanCardHtml(bean, data, dark, now, note) {
    const rows = [];
    const row = (label, value) => rows.push(`<div class="row"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`);
    if (bean.roaster) row("Roaster", bean.roaster);
    if (batch && batch.id === bean.batchId) {
      const days = batch.roastDate ? daysOffRoast(batch.roastDate, now) : null;
      if (days !== null) row("Roasted", days === 1 ? "1 day ago" : `${days} days ago`);
      if (batch.roastLevel) row("Roast", batch.roastLevel);
      if (batch.weightRemaining !== null) row("Beans left", `${fmt(batch.weightRemaining, 0)} g`);
    }
    if (data && data.total !== null) row("Shots with it", String(data.total));
    const s = data && data.lastShot;
    if (s) {
      if (s.at !== null) row("Last shot", ago(s.at, now));
      if (s.profile) row("Profile", s.profile);
      if (s.grind !== null) row("Grind", fmt(s.grind, 2));
      const out = s.yieldActual ?? s.yieldTarget;
      if (s.dose !== null && out !== null) row("Dose → yield", `${fmt(s.dose, 1)} g → ${fmt(out, 1)} g`);
      const secs = durationCache[s.id];
      if (Number.isFinite(secs) && secs > 0) row("Time", `${secs} s`);
    }
    const message = note || (data ? "" : "Shot history is not available right now.");
    if (message) rows.push(`<p class="muted">${escapeHtml(message)}</p>`);
    const c = dark
      ? { bg: "#1f2328", fg: "#f2f2f2", muted: "#9aa3ad", line: "#33393f", btn: "#2c3238" }
      : { bg: "#ffffff", fg: "#121212", muted: "#6b7480", line: "#e6e8eb", btn: "#eef0f2" };
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(bean.name)}</title>
<style>
html,body{margin:0;background:transparent;font-family:Inter,system-ui,sans-serif}
.card{box-sizing:border-box;width:440px;padding:24px 28px 20px;background:${c.bg};color:${c.fg};border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.25)}
h1{margin:0 32px 14px 0;font-size:26px;line-height:32px;font-weight:700;overflow-wrap:anywhere}
.row{display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-top:1px solid ${c.line};font-size:19px}
.row span{color:${c.muted}}.row b{font-weight:600;text-align:right;overflow-wrap:anywhere}
.muted{color:${c.muted};font-size:17px;margin:10px 0 0}
button{margin-top:16px;width:100%;height:52px;border:0;border-radius:12px;background:${c.btn};color:${c.fg};font:600 19px Inter,system-ui,sans-serif}
</style></head><body>
<div class="card" id="card"><h1>${escapeHtml(bean.name)}</h1>${rows.join("")}<button id="close" type="button">Close</button></div>
<script>
(function(){
  function post(m){ try { window.parent.postMessage(m, "*"); } catch (e) {} }
  function size(){ var r = document.getElementById("card").getBoundingClientRect(); post({ type: "streamline:size", width: Math.ceil(r.width), height: Math.ceil(r.height) }); }
  document.getElementById("close").addEventListener("click", function(){ post({ type: "streamline:close" }); });
  post({ type: "streamline:ready" });
  size();
})();
</script></body></html>`;
  }

  // A plugin page sits on Decaid's origin; when the skin is served from another
  // origin, frame-ancestors lets that origin show it in its overlay.
  function frameAncestors(request) {
    const h = request.headers || {};
    const pick = name => {
      for (const k of Object.keys(h)) if (k.toLowerCase() === name) return Array.isArray(h[k]) ? h[k][0] : h[k];
      return "";
    };
    const source = text(pick("origin")) || text(pick("referer"));
    const m = source.match(/^(https?:\/\/[A-Za-z0-9.\-\[\]:]+)(?:\/|$)/);
    return m ? `frame-ancestors 'self' ${m[1]}` : "frame-ancestors 'self'";
  }

  async function serveBeanCard(request) {
    const bean = currentBean(workflow);
    const now = Date.now();
    const headers = { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": frameAncestors(request) };
    const dark = request.query && request.query.theme === "dark";
    if (!bean) {
      return { requestId: request.requestId, status: 200, headers,
        body: beanCardHtml({ name: "No coffee chosen", roaster: "", batchId: "" }, { total: null, lastShot: null }, dark, now,
          "Choose a coffee for this workflow to see it here.") };
    }
    let data = null;
    try {
      data = await beanCardData(bean);
      const s = data.lastShot;
      if (s && !Object.prototype.hasOwnProperty.call(durationCache, s.id)) {
        const full = await getJson(`/shots/${encodeURIComponent(s.id)}`);
        rememberDuration(s.id, shotDuration(full && full.measurements));
      }
    } catch (e) {
      log(`bean card: ${e && e.message}`);
    }
    return { requestId: request.requestId, status: 200, headers, body: beanCardHtml(bean, data, dark, now) };
  }

  function json(request, status, body) {
    return {
      requestId: request.requestId,
      status,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  return {
    id: ID,
    version: "1.0.0",

    onLoad(loaded) {
      generation += 1;
      const s = loaded || {};
      settings = {
        liveStrip: toBool(s.LiveStrip, true),
        pills: toBool(s.LastShotPills, true),
        beanButton: toBool(s.BeanButton, true),
        matchBy: [MATCH.profile, MATCH.coffee, MATCH.any].includes(s.MatchBy) ? s.MatchBy : MATCH.profile,
      };
      const gen = generation;
      return loadWorkflow().then(() => (gen === generation ? refresh() : undefined));
    },

    onUnload() {
      generation += 1;
      refreshing = null;
      refreshAgain = false;
    },

    onEvent(event) {
      if (!event || typeof event.name !== "string") return;
      switch (event.name) {
        case "workflowUpdated":
          onWorkflow(event.payload);
          break;
        case "shotStored":
        case "shotUpdated":
          refresh();
          break;
        default:
          break;
      }
    },

    // The skin gives `skin` 2 s and expects no dependence on the machine, so
    // answer from what is already known and catch up in the background.
    __httpRequestHandler(request) {
      if (request.endpoint === "ui") return serveBeanCard(request);
      if (request.endpoint !== "skin") return json(request, 404, { error: "not found" });
      const now = Date.now();
      if (settings.liveStrip && today && today.day !== localDay(now)) refresh();
      const answer = skinAnswer(now);
      lastServed = answerKey(answer);
      return json(request, 200, answer);
    },
  };
}
