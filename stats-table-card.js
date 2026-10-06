/*
 * stats-table-card — таблица отчёта для Home Assistant из долгосрочной статистики (recorder).
 *
 * Данные берутся через websocket recorder/statistics_during_period — агрегацию делает сам HA,
 * поэтому таблица за месяц или год строится за доли секунды и не зависит от очистки
 * (purge) истории состояний.
 *
 * https://github.com/Lordhmen/stats-table-card
 * Лицензия: MIT. История изменений — CHANGELOG.md.
 */
const STC_VERSION = "1.0.0";

function tzParts(ms, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const x of dtf.formatToParts(new Date(ms))) p[x.type] = x.value;
  return p;
}
function tzOffset(ms, tz) {
  const p = tzParts(ms, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}
// Полночь даты "YYYY-MM-DD" в часовом поясе tz -> UTC ms
function zonedMidnight(dateStr, tz) {
  const [y, m, d] = String(dateStr).slice(0, 10).split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffset(guess, tz);
  const off2 = tzOffset(t, tz);
  if (guess - off2 !== t) t = guess - off2;
  return t;
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function ymd(ms, tz) {
  const p = tzParts(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toMs(v) {
  return typeof v === "number" ? v : Date.parse(v);
}
function nn(v) {
  return v !== null && v !== undefined && !Number.isNaN(v);
}
function aggregate(vals, how) {
  const v = vals.filter(nn);
  if (how === "avg_nonzero") {
    const nz = v.filter((x) => x > 0);
    if (!nz.length) return v.length ? 0 : null;
    return nz.reduce((a, b) => a + b, 0) / nz.length;
  }
  if (!v.length) return null;
  switch (how) {
    case "sum": return v.reduce((a, b) => a + b, 0);
    case "min": return Math.min(...v);
    case "max": return Math.max(...v);
    case "count": return v.length;
    case "first": return v[0];
    case "last": return v[v.length - 1];
    default: return v.reduce((a, b) => a + b, 0) / v.length; // avg
  }
}

const HL_RANK = { good: 1, warn: 2, bad: 3 };
function matchRule(x, r) {
  if (x === null || x === undefined) return !!r.empty;
  if (r.empty) return false;
  if (r.below !== undefined && !(x < r.below)) return false;
  if (r.above !== undefined && !(x > r.above)) return false;
  if (r.equals !== undefined && !(Math.abs(x - r.equals) < 1e-9)) return false;
  return r.below !== undefined || r.above !== undefined || r.equals !== undefined;
}
function pickRule(x, rules) {
  let best = null;
  for (const r of rules || []) if (matchRule(x, r) && (!best || (HL_RANK[r.level || "warn"] || 2) > (HL_RANK[best.level || "warn"] || 2))) best = r;
  return best;
}
function ruleText(r, col, sep) {
  const u = col.unit ? ` ${col.unit}` : "";
  const n = (v) => String(v).replace(".", sep);
  if (r.label) return r.label;
  if (r.empty) return `${col.name || ""}: нет данных`;
  const parts = [];
  if (r.above !== undefined) parts.push(`> ${n(r.above)}${u}`);
  if (r.below !== undefined) parts.push(`< ${n(r.below)}${u}`);
  if (r.equals !== undefined) parts.push(`= ${n(r.equals)}${u}`);
  return `${col.group ? col.group + " " : ""}${col.name || ""} ${parts.join(" и ")}`.trim();
}

const PRESET_LABELS = {
  today: "Сегодня", yesterday: "Вчера", "3d": "3 дня", "7d": "7 дней", "30d": "30 дней",
  month: "Этот месяц", prev_month: "Прошлый месяц", year: "Этот год",
};
function lastDayOfMonth(y, m) { // m: 1..12
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function pad2(n) { return String(n).padStart(2, "0"); }
function presetRange(name, today) {
  const [y, m] = today.split("-").map(Number);
  switch (name) {
    case "today": return [today, today];
    case "yesterday": { const d = addDays(today, -1); return [d, d]; }
    case "3d": return [addDays(today, -2), today];
    case "7d": return [addDays(today, -6), today];
    case "30d": return [addDays(today, -29), today];
    case "month": return [`${y}-${pad2(m)}-01`, today];
    case "prev_month": {
      const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
      return [`${py}-${pad2(pm)}-01`, `${py}-${pad2(pm)}-${pad2(lastDayOfMonth(py, pm))}`];
    }
    case "year": return [`${y}-01-01`, today];
    default: return null;
  }
}
// Начало интервала week/month, в который попадает дата (неделя — с понедельника, как в HA)
function alignDate(dateStr, period) {
  if (period === "month") return `${dateStr.slice(0, 7)}-01`;
  if (period === "week") {
    const dow = new Date(dateStr + "T00:00:00Z").getUTCDay();
    return addDays(dateStr, -((dow + 6) % 7));
  }
  return dateStr;
}
// Конец интервала (начало следующего), начинающегося в дату dateStr
function nextPeriodDate(dateStr, period) {
  if (period === "week") return addDays(dateStr, 7);
  if (period === "month") {
    const [y, m] = dateStr.split("-").map(Number);
    return m === 12 ? `${y + 1}-01-01` : `${y}-${pad2(m + 1)}-01`;
  }
  return addDays(dateStr, 1);
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}
function isFullMonth(a, b) {
  const [ya, ma, da] = a.split("-").map(Number);
  const [yb, mb, db] = b.split("-").map(Number);
  return da === 1 && ya === yb && ma === mb && db === lastDayOfMonth(yb, mb);
}

class StatsTableCard extends HTMLElement {
  // Конфигурация по умолчанию при добавлении карточки через UI
  static getStubConfig(hass) {
    const states = hass?.states || {};
    const ids = Object.keys(states).filter((id) => id.startsWith("sensor.") && states[id].attributes?.state_class);
    const total = ids.find((id) => /^total/.test(states[id].attributes.state_class));
    const entity = total || ids[0] || "sensor.example";
    const a = states[entity]?.attributes || {};
    return {
      title: "Отчёт",
      period: "day",
      columns: [{ entity, name: a.friendly_name || "Значение", unit: a.unit_of_measurement || "", stat: total ? "change" : "mean" }],
    };
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.columns) || !config.columns.length) {
      throw new Error("Нужен список columns");
    }
    for (const c of config.columns) {
      if (!c.entity && !c.formula) throw new Error("У каждого столбца нужен entity или formula");
    }
    this._config = {
      period: "day",
      decimal_separator: ",",
      live_today: true,
      refresh_interval: 300,
      empty: "—",
      show_footer: true,
      footer_labels: true,
      footer_title: "Итог",
      csv: true,
      ...config,
    };
    const cols = this._config.columns;
    this._columns = cols.map((c, i) => {
      const next = cols[i + 1];
      return {
        stat: c.formula ? null : "mean",
        decimals: 2,
        footer: c.stat === "change" || c.agg === "sum" ? "sum" : "avg",
        ...c,
        _key: `c${i}`,
        _groupEnd: !!next && (next.group || null) !== (c.group || null),
      };
    });
    this._hidden = this._columns
      .filter((c) => c.prefer && c.prefer.entity)
      .map((c) => ({
        stat: "change",
        multiplier: c.multiplier,
        ...c.prefer,
        _key: `${c._key}p`,
        _hidden: true,
      }));
    this._hasGroups = this._columns.some((c) => c.group);
    this._rangeKey = null;
    this._useEntities = !!(this._config.start_entity && this._config.end_entity) && this._config.range_mode !== "card";
    this._presets = this._config.presets || (this._config.period === "hour" ? ["today", "yesterday", "3d"] : ["7d", "month", "prev_month", "year"]);
    this._sel = null;
    this._activePreset = null;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._renderShell();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._useEntities && !this._sel) this._initSelection();
    if (!this._barBuilt) this._buildBar();
    const key = this._computeRangeKey();
    if (first || key !== this._rangeKey) {
      this._rangeKey = key;
      this._syncBar();
      this._load();
    }
  }

  connectedCallback() {
    const sec = Number(this._config?.refresh_interval || 0);
    if (sec > 0 && !this._timer) this._timer = setInterval(() => this._load(), sec * 1000);
  }
  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  getCardSize() {
    return 3 + (this._rows ? this._rows.length : 7);
  }

  get _tz() {
    return this._config.time_zone || this._hass?.config?.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  _stateOf(entity) {
    const s = this._hass?.states?.[entity];
    return s ? s.state : null;
  }

  // Диапазон дат: start/end из input_datetime, либо days_back
  _range() {
    const c = this._config;
    const tz = this._tz;
    const today = ymd(Date.now(), tz);
    let start, end;
    if (!this._useEntities) {
      if (!this._sel) return null;
      [start, end] = this._sel;
    } else if (c.start_entity && c.end_entity) {
      start = this._stateOf(c.start_entity);
      end = this._stateOf(c.end_entity);
      if (!start || !end || /unknown|unavailable/.test(start + end)) return null;
      start = start.slice(0, 10);
      end = end.slice(0, 10);
    } else {
      const back = Number(c.days_back || 7);
      end = today;
      start = addDays(today, -(back - 1));
    }
    if (end > today) end = today;
    if (start > end) return { start, end, invalid: true };
    return { start, end, today };
  }

  get _storageKey() {
    const c = this._config;
    return `stc:${c.storage_key || `${location.pathname}|${c.title || ""}`}`;
  }

  _today() {
    return ymd(Date.now(), this._tz);
  }

  _initSelection() {
    const c = this._config;
    const valid = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
    let sel = null, preset = null;
    try {
      const q = new URLSearchParams(location.search);
      if (c.url_params !== false && valid(q.get("from")) && valid(q.get("to"))) sel = [q.get("from"), q.get("to")];
    } catch (_) {}
    if (!sel) {
      try {
        const saved = JSON.parse(localStorage.getItem(this._storageKey) || "null");
        if (saved && saved.preset && presetRange(saved.preset, this._today())) {
          preset = saved.preset;
          sel = presetRange(preset, this._today());
        } else if (saved && valid(saved.start) && valid(saved.end)) sel = [saved.start, saved.end];
      } catch (_) {}
    }
    if (!sel) {
      preset = c.default_range || (c.period === "hour" ? "today" : "month");
      sel = presetRange(preset, this._today()) || presetRange("today", this._today());
    }
    this._sel = sel;
    this._activePreset = preset;
  }

  _setRange(start, end, preset = null) {
    if (!start || !end) return;
    if (start > end) [start, end] = [end, start];
    this._activePreset = preset;
    if (this._useEntities) {
      const c = this._config;
      this._hass.callService("input_datetime", "set_datetime", { entity_id: c.start_entity, date: start });
      this._hass.callService("input_datetime", "set_datetime", { entity_id: c.end_entity, date: end });
    } else {
      this._sel = [start, end];
      try {
        localStorage.setItem(this._storageKey, JSON.stringify(preset ? { preset } : { start, end }));
      } catch (_) {}
      this._rangeKey = this._computeRangeKey();
      this._load();
    }
    this._syncBar();
  }

  _shift(dir) {
    const r = this._range();
    if (!r) return;
    let s, e;
    if (isFullMonth(r.start, r.end) || (this._activePreset === "month" && r.start.endsWith("-01"))) {
      let [y, m] = r.start.split("-").map(Number);
      m += dir;
      if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
      s = `${y}-${pad2(m)}-01`;
      e = `${y}-${pad2(m)}-${pad2(lastDayOfMonth(y, m))}`;
    } else {
      const len = daysBetween(r.start, r.end) + 1;
      s = addDays(r.start, dir * len);
      e = addDays(r.end, dir * len);
    }
    const today = this._today();
    if (s > today) return;
    if (e > today) e = today;
    this._setRange(s, e, null);
  }

  _buildBar() {
    const bar = this.shadowRoot.getElementById("bar");
    if (!bar || this._config.controls === false) {
      if (bar) bar.style.display = "none";
      return;
    }
    bar.innerHTML = `
      <div class="nav">
        <button class="ic" data-shift="-1" title="Назад">&#9664;</button>
        <input type="date" id="d1" aria-label="С">
        <span class="dash">—</span>
        <input type="date" id="d2" aria-label="По">
        <button class="ic" data-shift="1" title="Вперёд">&#9654;</button>
      </div>
      <div class="presets">${this._presets
        .filter((p) => PRESET_LABELS[p])
        .map((p) => `<button class="chip" data-preset="${p}">${PRESET_LABELS[p]}</button>`)
        .join("")}</div>`;
    bar.querySelectorAll("[data-shift]").forEach((b) => b.addEventListener("click", () => this._shift(Number(b.dataset.shift))));
    bar.querySelectorAll("[data-preset]").forEach((b) =>
      b.addEventListener("click", () => {
        const r = presetRange(b.dataset.preset, this._today());
        if (r) this._setRange(r[0], r[1], b.dataset.preset);
      })
    );
    const d1 = bar.querySelector("#d1"), d2 = bar.querySelector("#d2");
    if (!d1 || !d2) { this._barBuilt = true; return; }
    const onDate = () => {
      if (d1.value && d2.value) this._setRange(d1.value, d2.value, null);
    };
    d1.addEventListener("change", onDate);
    d2.addEventListener("change", onDate);
    this._barBuilt = true;
    this._syncBar();
  }

  _syncBar() {
    const bar = this.shadowRoot?.getElementById("bar");
    if (!bar || !this._barBuilt) return;
    const r = this._range();
    const today = this._today();
    const d1 = bar.querySelector("#d1"), d2 = bar.querySelector("#d2");
    if (r && d1 && d2) {
      if (d1.value !== r.start) d1.value = r.start;
      if (d2.value !== r.end) d2.value = r.end;
      d1.max = today;
      d2.max = today;
      const next = bar.querySelector('[data-shift="1"]');
      if (next) next.disabled = r.end >= today;
    }
    let active = this._activePreset;
    if (!active && r) active = this._presets.find((p) => { const pr = presetRange(p, today); return pr && pr[0] === r.start && pr[1] === r.end; }) || null;
    bar.querySelectorAll("[data-preset]").forEach((b) => b.classList.toggle("on", b.dataset.preset === active));
  }

  _computeRangeKey() {
    const r = this._range();
    return r ? `${r.start}|${r.end}|${r.invalid ? 1 : 0}` : "none";
  }

  _ws(ids, period, types, startMs, endMs) {
    if (!ids.length || endMs <= startMs) return Promise.resolve({});
    return this._hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: new Date(startMs).toISOString(),
      end_time: new Date(endMs).toISOString(),
      statistic_ids: ids,
      period,
      types,
    });
  }

  async _load() {
    if (!this._hass || !this._config) return;
    if (!this._useEntities && this._activePreset) {
      const pr = presetRange(this._activePreset, this._today()); // переход через полночь для «Сегодня»/«Этот месяц»
      if (pr) this._sel = pr;
    }
    const range = this._range();
    if (!range) return this._renderError("Не заданы даты периода");
    if (range.invalid) return this._renderError("Начальная дата позже конечной");

    const seq = (this._seq = (this._seq || 0) + 1);
    const t0 = performance.now();
    const tz = this._tz;
    const c = this._config;
    const nowMs = Date.now();
    const startMs = zonedMidnight(alignDate(range.start, c.period), tz);
    const endMs = Math.min(zonedMidnight(addDays(range.end, 1), tz), nowMs);
    const statCols = [...this._columns.filter((col) => col.entity), ...(this._hidden || [])];
    const sinceMs = (str) => (!str ? -Infinity : String(str).length > 10 ? Date.parse(str) : zonedMidnight(str, tz));
    const PMS = { "5minute": 300000, hour: 3600000 };
    // Столбцы, собираемые из более мелкой статистики (hour -> day, 5minute -> hour/day)
    const fineCols = statCols.filter((col) => col.source_period && col.source_period !== c.period && PMS[col.source_period]);
    const directCols = statCols.filter((col) => !fineCols.includes(col));
    const fbCols = fineCols.filter((col) => col.fallback_stat);
    const uniq = (a) => [...new Set(a)];
    const dIds = uniq([...directCols, ...fbCols].map((col) => col.entity));
    const dTypes = uniq([...directCols.map((col) => col.stat), ...fbCols.map((col) => col.fallback_stat)]);
    const finePeriods = uniq(fineCols.map((col) => col.source_period));
    const summaryCells = (c.summary || []).flatMap((r) => r.cells || []).filter((x) => x.entity);
    const sIds = uniq(summaryCells.map((x) => x.entity));
    const sTypes = uniq(summaryCells.map((x) => x.stat || "mean"));
    const keyOf = (ms) =>
      c.period === "day" ? ymd(ms, tz) : c.period === "hour" ? String(Math.floor(ms / 3600000) * 3600000) : String(ms);

    try {
      const liveToday = c.live_today && c.period === "day" && range.end === range.today && directCols.length;
      const todayStart = zonedMidnight(range.today, tz);
      const fineReq = finePeriods.map((fp) => {
        const cols = fineCols.filter((col) => col.source_period === fp);
        return this._ws(uniq(cols.map((x) => x.entity)), fp, uniq(cols.map((x) => x.stat)), startMs, endMs);
      });
      const [res, sres, live, ...fineRes] = await Promise.all([
        this._ws(dIds, c.period, dTypes, startMs, endMs),
        this._ws(sIds, "hour", sTypes, startMs, endMs),
        liveToday ? this._ws(uniq(directCols.map((x) => x.entity)), "5minute", uniq(directCols.map((x) => x.stat)), todayStart, nowMs) : Promise.resolve(null),
        ...fineReq,
      ]);

      // Сетка строк
      const buckets = new Map();
      if (c.period === "day") {
        for (let d = range.start; d <= range.end; d = addDays(d, 1)) {
          buckets.set(d, { key: d, start: zonedMidnight(d, tz), values: {} });
        }
      } else if (c.period === "hour") {
        for (let t = startMs; t < endMs; t += 3600000) buckets.set(keyOf(t), { key: keyOf(t), start: Number(keyOf(t)), values: {} });
      }
      for (const [sid, arr] of Object.entries(res || {})) {
        for (const pt of arr) {
          const s = toMs(pt.start);
          if (s < startMs || s >= endMs) continue;
          const k = keyOf(s);
          if (!buckets.has(k)) buckets.set(k, { key: k, start: s, values: {} });
          buckets.get(k).values[sid] = pt;
        }
      }

      // Сегодняшний день — из 5-минутной статистики (без часовой задержки)
      if (live) {
        const row = buckets.get(range.today) || { key: range.today, start: todayStart, values: {} };
        for (const [sid, arr] of Object.entries(live || {})) {
          if (!arr.length) continue;
          const agg = { ...(row.values[sid] || {}) };
          for (const t of uniq(directCols.map((x) => x.stat))) {
            const vals = arr.map((p) => p[t]);
            const how = t === "change" ? "sum" : t === "min" ? "min" : t === "max" ? "max" : t === "state" || t === "sum" ? "last" : "avg";
            const x = aggregate(vals, how);
            if (x !== null) agg[t] = x;
          }
          row.values[sid] = agg;
        }
        buckets.set(range.today, row);
      }

      // Мелкая статистика по строкам: period -> entity -> key -> [points]
      const fine = {};
      finePeriods.forEach((fp, i) => {
        const byEnt = (fine[fp] = {});
        for (const [sid, arr] of Object.entries(fineRes[i] || {})) {
          const m = (byEnt[sid] = {});
          for (const pt of arr) {
            const s = toMs(pt.start);
            if (s < startMs || s >= endMs) continue;
            const k = keyOf(s);
            if (!buckets.has(k)) buckets.set(k, { key: k, start: Number(k) || s, values: {} });
            (m[k] ||= []).push(pt);
          }
        }
      });

      const rows = [...buckets.values()]
        .sort((a, b) => a.start - b.start)
        .map((b) => {
          const v = {};
          for (const col of statCols) {
            let x = null;
            if (fineCols.includes(col)) {
              const pts = (fine[col.source_period]?.[col.entity]?.[b.key] || []).slice().sort((p, q) => toMs(p.start) - toMs(q.start));
              x = aggregate(pts.map((p) => p[col.stat]), col.agg || "avg");
              if (!nn(x) && col.fallback_stat) {
                const pt = b.values[col.entity];
                x = pt ? pt[col.fallback_stat] : null;
              }
            } else {
              const pt = b.values[col.entity];
              x = pt ? pt[col.stat] : null;
            }
            v[col._key] = nn(x) ? Number(x) * (col.multiplier ?? 1) : null;
          }
          // prefer: точный источник для завершённых интервалов
          const bEnd =
            c.period === "hour" ? b.start + 3600000
            : c.period === "5minute" ? b.start + 300000
            : zonedMidnight(nextPeriodDate(ymd(b.start, tz), c.period), tz);
          for (const col of this._columns) {
            if (!col.prefer || !col.prefer.entity) continue;
            const pv = v[`${col._key}p`];
            if (bEnd <= nowMs && b.start >= sinceMs(col.prefer.since || c.prefer_since) && nn(pv)) v[col._key] = pv;
          }
          for (const col of this._columns) {
            if (col.formula) v[col._key] = this._evalFormula(col.formula, v);
          }
          return { start: b.start, v };
        });

      const summary = (c.summary || []).map((r) => ({
        label: r.label || "",
        cells: (r.cells || []).map((cell) => {
          let val = null;
          if (cell.entity) {
            const arr = (sres || {})[cell.entity] || [];
            val = aggregate(
              arr.filter((p) => toMs(p.start) >= startMs && toMs(p.start) < endMs).map((p) => p[cell.stat || "mean"]),
              cell.agg || "avg"
            );
          }
          return { ...cell, value: val };
        }),
      }));

      if (seq !== this._seq) return; // пришёл более свежий запрос
      this._rows = rows;
      this._summary = summary;
      this._range_ = range;
      this._loadedAt = Date.now();
      this._loadMs = Math.round(performance.now() - t0);
      this._render();
    } catch (e) {
      if (seq !== this._seq) return;
      this._renderError(e?.message || String(e));
    }
  }

  // formula: "c3 / c4" — ссылки на столбцы по индексу (c0, c1, ...)
  _evalFormula(expr, v) {
    try {
      const names = Object.keys(v);
      if (names.some((n) => v[n] === null && new RegExp(`\\b${n}\\b`).test(expr))) return null;
      if (!/^[\sc0-9+\-*/().]+$/.test(expr)) return null;
      const r = Function(...names, `return (${expr});`)(...names.map((n) => v[n]));
      return Number.isFinite(r) ? r : null;
    } catch (_) {
      return null;
    }
  }

  _fmt(x, decimals) {
    if (x === null || x === undefined) return this._config.empty;
    const s = Number(x).toFixed(decimals);
    return this._config.decimal_separator === "." ? s : s.replace(".", this._config.decimal_separator);
  }

  _rowLabel(ms) {
    const p = tzParts(ms, this._tz);
    switch (this._config.period) {
      case "5minute":
      case "hour":
        return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
      case "week": {
        const e = tzParts(ms + 6 * 86400000, this._tz);
        return `${p.day}.${p.month}–${e.day}.${e.month}`;
      }
      case "month":
        return `${p.month}.${p.year}`;
      default:
        return this._config.date_format === "DD.MM" ? `${p.day}.${p.month}` : `${p.day}.${p.month}.${p.year}`;
    }
  }

  _footerValue(col, how = col.footer) {
    const vals = (this._rows || []).map((r) => r.v[col._key]);
    if (!how || how === "none") return null;
    return aggregate(vals, how);
  }

  _dateLabel() {
    const r = this._range_;
    if (!r) return "";
    const f = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
    return r.start === r.end ? f(r.start) : `${f(r.start)} — ${f(r.end)}`;
  }

  _renderShell() {
    const fs = this._config?.font_size || ".8em";
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { display: block; padding: 16px; }
        .head { display: grid; grid-template-columns: 1fr 2fr 1fr; align-items: end; }
        .gen { font-family: monospace; font-size: .85em; color: var(--secondary-text-color); line-height: 1.2; font-weight: bold; }
        .title { text-align: center; }
        .title .t { font-weight: 800; font-size: 1.3em; text-transform: uppercase; }
        .title .s { font-size: .9em; color: var(--secondary-text-color); font-weight: bold; }
        .tools { text-align: right; }
        .tools button { background: none; border: 1px solid var(--divider-color); color: var(--primary-text-color);
          border-radius: 8px; padding: 4px 10px; font: inherit; font-size: .8em; cursor: pointer; }
        .tools .ms { font-size: .7em; color: var(--secondary-text-color); margin-top: 4px; }
        hr { border: 0; height: 1px; background: #555; margin: 15px 0; opacity: .3; }
        .wrap { overflow-x: auto; }
        table { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: ${fs}; }
        th, td { text-align: center; padding: 3px 4px; }
        thead th { border-bottom: 2px solid #555; background: var(--card-background-color, var(--ha-card-background)); }
        thead th .u { font-weight: normal; font-size: .85em; }
        thead tr.grp th { border-bottom: 1px solid #555; }
        th.date, td.date { border-right: 2px solid #555; width: 90px; }
        td.date { font-weight: bold; }
        table.cb th:not(:last-child), table.cb td:not(:last-child) { border-right: 1px solid rgba(127,127,127,.28); }
        table.cb tr.grp th { border-right: 1px solid rgba(127,127,127,.28); }
        .gend, table.cb .gend { border-right: 1px solid #555; }
        th.date, td.date, table.cb th.date, table.cb td.date { border-right: 2px solid #555; }
        tbody td { border-bottom: 1px solid #333; }
        tbody tr:nth-child(even) { background: rgba(255,255,255,.05); }
        td.dim { color: #aaa; }
        td.empty { color: var(--disabled-text-color, #777); }
        tfoot .lbl th { color: #aaa; font-size: .85em; font-weight: normal; border-top: 2px solid #555; }
        tfoot .val td { font-weight: bold; font-size: .9em; }
        tfoot .val.top td { border-top: 2px solid #555; }
        tfoot .val.dimrow td { color: #aaa; font-weight: normal; }
        tfoot td .u { font-weight: normal; font-size: .8em; }
        tfoot .sum td { border-top: 1px solid #555; background: rgba(255,255,255,.08); font-size: .95em; }
        tfoot .sum td.date { color: var(--primary-color); }
        #bar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; margin-bottom: 12px; }
        #bar .nav, #bar .presets { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
        #bar input[type=date] { font: inherit; font-size: .95em; padding: 5px 8px; border-radius: 8px; color: var(--primary-text-color);
          background: var(--secondary-background-color, transparent); border: 1px solid var(--divider-color); color-scheme: light dark; }
        #bar button { font: inherit; font-size: .85em; cursor: pointer; color: var(--primary-text-color); background: none;
          border: 1px solid var(--divider-color); border-radius: 16px; padding: 5px 12px; }
        #bar button.ic { border-radius: 8px; padding: 5px 10px; }
        #bar button.on { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
        #bar button:disabled { opacity: .35; cursor: default; }
        #bar .dash { color: var(--secondary-text-color); }
        td.hl-warn { background: rgba(255, 167, 38, .22); color: #ffb74d; font-weight: 600; }
        td.hl-bad { background: rgba(244, 67, 54, .25); color: #ff8a80; font-weight: 700; }
        td.hl-good { background: rgba(76, 175, 80, .2); color: #81c784; }
        tr.row-warn td.date { box-shadow: inset 4px 0 0 #ffa726; }
        tr.row-bad td.date { box-shadow: inset 4px 0 0 #f44336; }
        .legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 10px; font-size: .78em; color: var(--secondary-text-color); }
        .legend .lg { display: inline-flex; align-items: center; gap: 6px; }
        .legend .sw { display: inline-block; width: 12px; height: 12px; border-radius: 3px; }
        .legend .sw.hl-warn { background: #ffa726; } .legend .sw.hl-bad { background: #f44336; } .legend .sw.hl-good { background: #4caf50; }
        .msg { padding: 16px; text-align: center; color: var(--secondary-text-color); }
        .err { color: var(--error-color, #db4437); }
        @media print {
          td[class*="hl-"], .legend .sw, tr[class*="row-"] td.date { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          td.hl-warn { color: #8a4b00; } td.hl-bad { color: #9b1c1c; } td.hl-good { color: #1b5e20; }
          .tools, #bar { display: none !important; }
          ha-card { box-shadow: none; border: none; }
          thead th { background: none; }
        }
      </style>
      <ha-card><div id="bar"></div><div id="root"><div class="msg">Загрузка…</div></div></ha-card>`;
    this._barBuilt = false;
  }

  _renderError(msg) {
    const root = this.shadowRoot?.getElementById("root");
    if (root) root.innerHTML = `<div class="msg err">${esc(msg)}</div>`;
  }

  _footerGroups() {
    const names = { avg: "СРЕДНИЕ", avg_nonzero: "СРЕДНИЕ", sum: "ИТОГО", min: "МИН", max: "МАКС" };
    const groups = [];
    for (const col of this._columns) {
      const lbl = col.footer_label || names[col.footer] || "";
      const last = groups[groups.length - 1];
      if (last && last.lbl === lbl) last.span++;
      else groups.push({ lbl, span: 1 });
    }
    return groups;
  }

  _colHead(col) {
    return `${esc(col.name || col.entity)}${col.unit ? `<br><span class="u">(${esc(col.unit)})</span>` : ""}`;
  }

  _renderHead() {
    const c = this._config;
    const dateTh = (rs) => `<th class="date"${rs ? ` rowspan="${rs}"` : ""}>${esc(c.date_header || "Дата")}</th>`;
    if (!this._hasGroups) {
      return `<tr>${dateTh()}${this._columns.map((col) => `<th${col._groupEnd ? ' class="gend"' : ""}>${this._colHead(col)}</th>`).join("")}</tr>`;
    }
    let top = "";
    const sub = [];
    const cols = this._columns;
    for (let i = 0; i < cols.length; ) {
      const g = cols[i].group;
      if (!g) {
        top += `<th rowspan="2"${cols[i]._groupEnd ? ' class="gend"' : ""}>${this._colHead(cols[i])}</th>`;
        i++;
        continue;
      }
      let j = i;
      while (j < cols.length && cols[j].group === g) j++;
      const lastCol = cols[j - 1];
      top += `<th colspan="${j - i}"${lastCol._groupEnd ? ' class="gend"' : ""}>${esc(g)}</th>`;
      for (let k = i; k < j; k++) sub.push(`<th${cols[k]._groupEnd ? ' class="gend"' : ""}>${this._colHead(cols[k])}</th>`);
      i = j;
    }
    return `<tr class="grp">${dateTh(2)}${top}</tr><tr>${sub.join("")}</tr>`;
  }

  _render() {
    const c = this._config;
    const root = this.shadowRoot.getElementById("root");
    const now = tzParts(this._loadedAt, this._tz);
    const subtitle = (c.subtitle || "За {range}").replace("{range}", this._dateLabel());

    const body = this._rows
      .map((r) => {
        let rowLevel = null;
        const cells = this._columns
          .map((col) => {
            const x = r.v[col._key];
            const hr = col.highlight ? pickRule(x, col.highlight) : null;
            if (hr && hr.row && (!rowLevel || HL_RANK[hr.level || "warn"] > HL_RANK[rowLevel])) rowLevel = hr.level || "warn";
            const cls = [x === null ? "empty" : "", col.dim && !hr ? "dim" : "", col._groupEnd ? "gend" : "", hr ? `hl-${hr.level || "warn"}` : ""].join(" ").trim();
            const tip = hr ? ` title="${esc(ruleText(hr, col, c.decimal_separator))}"` : "";
            return `<td${cls ? ` class="${cls}"` : ""}${tip}>${this._fmt(x, col.decimals)}</td>`;
          })
          .join("");
        return `<tr${rowLevel ? ` class="row-${rowLevel}"` : ""}><td class="date">${this._rowLabel(r.start)}</td>${cells}</tr>`;
      })
      .join("");

    let foot = "";
    if (c.show_footer && this._rows.length) {
      const fRows = Array.isArray(c.footers) && c.footers.length ? c.footers : [{ title: c.footer_title }];
      if (c.footer_labels && !Array.isArray(c.footers)) {
        const lbls = this._footerGroups().map((g) => `<th colspan="${g.span}">${esc(g.lbl)}</th>`).join("");
        foot += `<tr class="lbl"><th class="date"></th>${lbls}</tr>`;
      }
      fRows.forEach((fr, i) => {
        const vals = this._columns
          .map((col) => {
            const cls = [col.dim || fr.dim ? "dim" : "", col._groupEnd ? "gend" : ""].join(" ").trim();
            const how = fr.agg || col.footer;
            const show = how && how !== "none";
            return `<td${cls ? ` class="${cls}"` : ""}>${show ? this._fmt(this._footerValue(col, how), fr.decimals ?? col.footer_decimals ?? col.decimals) : ""}</td>`;
          })
          .join("");
        const top = i === 0 && !(c.footer_labels && !Array.isArray(c.footers)) ? " top" : "";
        const unit = fr.unit ? `<br><span class="u">${esc(fr.unit)}</span>` : "";
        foot += `<tr class="val${top}${fr.dim ? " dimrow" : ""}"><td class="date">${esc(fr.title ?? c.footer_title)}${unit}</td>${vals}</tr>`;
      });
    }
    for (const s of this._summary || []) {
      const cells = s.cells
        .map((cell) => {
          const v = cell.entity ? `<b>${this._fmt(cell.value, cell.decimals ?? 1)}</b>` : "";
          return `<td colspan="${cell.span || 1}"${cell.gend ? ' class="gend"' : ""}>${esc(cell.prefix || "")}${v}${esc(cell.suffix || "")}</td>`;
        })
        .join("");
      foot += `<tr class="sum"><td class="date">${esc(s.label)}</td>${cells}</tr>`;
    }

    root.innerHTML = `
      <div class="head">
        <div class="gen">${now.day}.${now.month}.${now.year}<br>${now.hour}:${now.minute}:${now.second}</div>
        <div class="title">
          ${c.title ? `<div class="t">${esc(c.title)}</div>` : ""}
          <div class="s">${esc(subtitle)}</div>
        </div>
        <div class="tools">
          ${c.csv ? `<button id="csv" title="Скачать CSV для Excel">CSV</button>` : ""}
          ${c.show_debug ? `<div class="ms">${this._loadMs} мс · v${STC_VERSION}</div>` : ""}
        </div>
      </div>
      <hr>
      ${this._rows.length ? "" : `<div class="msg">Нет данных за период</div>`}
      <div class="wrap"><table${c.column_borders === false ? "" : ' class="cb"'}>
        <thead>${this._renderHead()}</thead>
        <tbody>${body}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ""}
      </table></div>${this._legend()}`;

    const btn = root.querySelector("#csv");
    if (btn) btn.addEventListener("click", () => this._downloadCsv());
  }

  _legend() {
    const c = this._config;
    if (c.highlight_legend === false) return "";
    const items = [];
    for (const col of this._columns) for (const r of col.highlight || []) items.push(`<span class="lg"><i class="sw hl-${r.level || "warn"}"></i>${esc(ruleText(r, col, c.decimal_separator))}</span>`);
    return items.length ? `<div class="legend">${items.join("")}</div>` : "";
  }

  _downloadCsv() {
    const sep = ";";
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const num = (x, d) => (x === null || x === undefined ? "" : Number(x).toFixed(d).replace(".", ","));
    const lines = [];
    lines.push([
      q(this._config.date_header || "Дата"),
      ...this._columns.map((col) => q(`${col.group ? col.group + " " : ""}${col.name || col.entity}${col.unit ? ` (${col.unit})` : ""}`)),
    ].join(sep));
    for (const r of this._rows) {
      lines.push([q(this._rowLabel(r.start)), ...this._columns.map((col) => num(r.v[col._key], col.decimals))].join(sep));
    }
    if (this._config.show_footer) {
      const fRows = Array.isArray(this._config.footers) && this._config.footers.length ? this._config.footers : [{ title: this._config.footer_title }];
      for (const fr of fRows) {
        lines.push([
          q(fr.title ?? this._config.footer_title),
          ...this._columns.map((col) => num(this._footerValue(col, fr.agg || col.footer), fr.decimals ?? col.footer_decimals ?? col.decimals)),
        ].join(sep));
      }
    }
    for (const s of this._summary || []) {
      lines.push([q(s.label), ...s.cells.filter((x) => x.entity).map((x) => q(`${x.prefix || ""}${num(x.value, x.decimals ?? 1)}${x.suffix || ""}`))].join(sep));
    }
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    const r = this._range_;
    a.href = URL.createObjectURL(blob);
    a.download = `${(this._config.title || "report").replace(/[^\wа-яё -]+/gi, "_")}_${r.start}_${r.end}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
}

if (!customElements.get("stats-table-card")) {
  customElements.define("stats-table-card", StatsTableCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "stats-table-card",
    name: "Stats Table Card",
    description: "Таблица отчёта из долгосрочной статистики HA",
    preview: false,
    documentationURL: "https://github.com/Lordhmen/stats-table-card",
  });
  console.info(`%c STATS-TABLE-CARD %c v${STC_VERSION} `, "background:#2196F3;color:#fff", "");
}
