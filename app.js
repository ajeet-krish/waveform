'use strict';
/* LiftLog — local-first workout + body tracker. All data lives in localStorage on the device. */

const KEY = 'liftlog.v1';
const LB = 2.20462, IN = 2.54;
const MUSCLES = ['Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Core', 'Other'];
const SEED = {
  Chest: ['Bench Press (Barbell)', 'Incline Bench Press (Barbell)', 'Bench Press (Dumbbell)', 'Incline Bench Press (Dumbbell)', 'Chest Fly (Dumbbell)', 'Cable Fly', 'Machine Chest Press', 'Push Up', 'Chest Dip'],
  Back: ['Deadlift (Barbell)', 'Pull Up', 'Chin Up', 'Lat Pulldown', 'Bent Over Row (Barbell)', 'Seated Cable Row', 'One-Arm Row (Dumbbell)', 'T-Bar Row', 'Face Pull', 'Back Extension'],
  Legs: ['Squat (Barbell)', 'Front Squat', 'Leg Press', 'Romanian Deadlift', 'Lunge (Dumbbell)', 'Bulgarian Split Squat', 'Leg Extension', 'Leg Curl', 'Hip Thrust (Barbell)', 'Goblet Squat', 'Standing Calf Raise', 'Seated Calf Raise'],
  Shoulders: ['Overhead Press (Barbell)', 'Shoulder Press (Dumbbell)', 'Lateral Raise (Dumbbell)', 'Rear Delt Fly', 'Front Raise', 'Arnold Press', 'Upright Row', 'Shrug (Dumbbell)'],
  Arms: ['Bicep Curl (Dumbbell)', 'Barbell Curl', 'Hammer Curl', 'Preacher Curl', 'Triceps Pushdown', 'Skullcrusher', 'Overhead Triceps Extension', 'Close Grip Bench Press', 'Triceps Dip'],
  Core: ['Plank', 'Crunch', 'Hanging Leg Raise', 'Cable Crunch', 'Russian Twist', 'Ab Wheel']
};
// k = field key, t: w = body weight, p = percent, l = length
const BODY = [
  { k: 'weight', label: 'Weight', t: 'w' }, { k: 'bodyfat', label: 'Body fat', t: 'p' },
  { k: 'neck', label: 'Neck', t: 'l' }, { k: 'shoulders', label: 'Shoulders', t: 'l' }, { k: 'chest', label: 'Chest', t: 'l' },
  { k: 'bicep', label: 'Bicep', t: 'l' }, { k: 'waist', label: 'Waist', t: 'l' }, { k: 'hips', label: 'Hips', t: 'l' },
  { k: 'thigh', label: 'Thigh', t: 'l' }, { k: 'calf', label: 'Calf', t: 'l' }
];

/* ---------- storage ---------- */
function seed() {
  const exercises = [];
  for (const m in SEED) SEED[m].forEach(n => exercises.push({ id: uid(), name: n, muscle: m, custom: false }));
  return { v: 1, settings: { unit: 'lb', rest: 90 }, exercises, workouts: [], routines: [], body: [], active: null };
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && d.exercises) { d.settings = Object.assign({ unit: 'lb', rest: 90 }, d.settings); return d; }
  } catch (e) {}
  return seed();
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { toast('Could not save — storage full?'); } }

/* ---------- helpers ---------- */
function uid() { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4); }
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = s => document.querySelector(s);
const isLb = () => db.settings.unit === 'lb';
const fmt = n => String(Math.round(n * 10) / 10);
const wDisp = kg => isLb() ? kg * LB : kg;
const wParse = v => isLb() ? v / LB : v;
const wStr = kg => kg == null ? '–' : fmt(wDisp(kg));
const lenDisp = cm => isLb() ? cm / IN : cm;
const lenParse = v => isLb() ? v * IN : v;
const wUnit = () => isLb() ? 'lb' : 'kg';
const lUnit = () => isLb() ? 'in' : 'cm';
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isFinite(n) ? n : null; };
const e1rm = (w, r) => r <= 1 ? w : w * (1 + r / 30);
const exById = id => db.exercises.find(e => e.id === id);
const exName = id => (exById(id) || { name: 'Deleted exercise' }).name;
function pad(n) { return String(n).padStart(2, '0'); }
function dkey(d = new Date()) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function keyTs(k) { return new Date(k + 'T12:00:00').getTime(); }
function fmtDate(ts, long) {
  const d = new Date(ts), o = { month: 'short', day: 'numeric' };
  if (long) { o.weekday = 'short'; }
  if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
  return d.toLocaleDateString(undefined, o);
}
function dur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`;
}
function weekKey(ts) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (d.getDay() + 6) % 7); // Monday start
  return d.getTime();
}
const setVol = s => (s.w || 0) * (s.r || 0);
const wkVol = w => w.entries.reduce((a, e) => a + e.sets.reduce((b, s) => b + setVol(s), 0), 0);
const wkSets = w => w.entries.reduce((a, e) => a + e.sets.length, 0);
const sortedWk = () => db.workouts.slice().sort((a, b) => a.start - b.start);

let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2200);
}

/* ---------- derived data ---------- */
function prevSets(exId) {
  const ws = sortedWk();
  for (let i = ws.length - 1; i >= 0; i--) {
    const e = ws[i].entries.find(x => x.exId === exId);
    if (e && e.sets.length) return e.sets;
  }
  return [];
}
function exSessions(exId) {
  const out = [];
  sortedWk().forEach(w => {
    const e = w.entries.find(x => x.exId === exId);
    if (!e || !e.sets.length) return;
    out.push({
      t: w.start, wid: w.id, sets: e.sets,
      top: Math.max(...e.sets.map(s => s.w || 0)),
      e1: Math.max(...e.sets.map(s => e1rm(s.w || 0, s.r || 0))),
      vol: e.sets.reduce((a, s) => a + setVol(s), 0),
      reps: e.sets.reduce((a, s) => a + (s.r || 0), 0)
    });
  });
  return out;
}
function weekly(exId) {
  const m = {};
  sortedWk().forEach(w => {
    const k = weekKey(w.start);
    const ents = exId ? w.entries.filter(e => e.exId === exId) : w.entries;
    if (!ents.length) return;
    const o = m[k] = m[k] || { k, sessions: 0, sets: 0, reps: 0, vol: 0, top: 0 };
    o.sessions++;
    ents.forEach(e => e.sets.forEach(s => { o.sets++; o.reps += s.r || 0; o.vol += setVol(s); o.top = Math.max(o.top, s.w || 0); }));
  });
  return m;
}
function isPR(w, entry) {
  const best = Math.max(...entry.sets.map(s => e1rm(s.w || 0, s.r || 0)));
  if (best <= 0) return false;
  let prior = 0, seen = false;
  db.workouts.forEach(x => {
    if (x.start >= w.start) return;
    x.entries.forEach(e => { if (e.exId === entry.exId) e.sets.forEach(s => { seen = true; prior = Math.max(prior, e1rm(s.w || 0, s.r || 0)); }); });
  });
  return seen && best > prior + 0.01;
}

/* ---------- charts ---------- */
function lineChart(pts, f) {
  if (!pts.length) return '<div class="empty small">No data yet</div>';
  const W = 340, H = 170, L = 40, R = 10, T = 10, B = 22;
  let lo = Math.min(...pts.map(p => p.y)), hi = Math.max(...pts.map(p => p.y));
  if (hi === lo) { hi += 1; lo -= 1; }
  const pd = (hi - lo) * .12; lo -= pd; hi += pd;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const X = t => pts.length === 1 || t1 === t0 ? (L + W - R) / 2 : L + (t - t0) / (t1 - t0) * (W - L - R);
  const Y = y => T + (hi - y) / (hi - lo) * (H - T - B);
  let g = '';
  for (let i = 0; i <= 3; i++) {
    const v = lo + (hi - lo) * i / 3, y = Y(v);
    g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="#272d37"/><text x="${L - 5}" y="${y + 3}" text-anchor="end">${f(v)}</text>`;
  }
  const d = pts.map((p, i) => (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + Y(p.y).toFixed(1)).join(' ');
  const dots = pts.length <= 40 ? pts.map(p => `<circle cx="${X(p.t).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3" fill="#3b82f6"/>`).join('') : '';
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">${g}<path d="${d}" fill="none" stroke="#3b82f6" stroke-width="2.2" stroke-linejoin="round"/>${dots}
    <text x="${L}" y="${H - 6}">${fmtDate(t0)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${pts.length > 1 ? fmtDate(t1) : ''}</text></svg>`;
}
function barChart(items, f) {
  const W = 340, H = 140, B = 20, T = 14, n = items.length, bw = (W - 10) / n;
  const mx = Math.max(1, ...items.map(i => i.v));
  const bars = items.map((it, i) => {
    const h = it.v / mx * (H - B - T), x = 5 + i * bw;
    return `<rect x="${x + 2}" y="${H - B - h}" width="${bw - 4}" height="${Math.max(h, it.v ? 2 : 0)}" rx="3" fill="${i === n - 1 ? '#3b82f6' : '#2b3a55'}"/>
      ${it.v ? `<text x="${x + bw / 2}" y="${H - B - h - 3}" text-anchor="middle">${f(it.v)}</text>` : ''}
      ${i % 2 === (n - 1) % 2 ? `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${it.label}</text>` : ''}`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">${bars}</svg>`;
}
const kfmt = v => v >= 1000 ? fmt(v / 1000) + 'k' : fmt(v);
const pct = (a, b) => !b ? '' : `<span class="${a >= b ? 'up' : 'dn'}">${a >= b ? '▲' : '▼'}${Math.abs(Math.round((a - b) / b * 100))}%</span>`;

/* ---------- ui state ---------- */
let db = load();
const ui = { tab: 'workout', page: null, hseg: 'log', exQ: '', exM: 'All', exMetric: 'e1', bMetric: 'weight', bRange: 90, bDate: dkey() };
let rest = null, pick = null, newExFrom = null;

const ICON = {
  workout: '<path d="M6.5 6.5v11M17.5 6.5v11M3 9v6M21 9v6M6.5 12h11"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  exercises: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  body: '<path d="M3 17l5-5 4 4 8-9"/><path d="M15 7h5v5"/>'
};
const TABS = [['workout', 'Workout'], ['history', 'History'], ['exercises', 'Exercises'], ['body', 'Body']];

function render() {
  $('#tabs').innerHTML = TABS.map(([k, l]) =>
    `<button class="${ui.tab === k ? 'on' : ''}" data-act="tab" data-t="${k}"><svg viewBox="0 0 24 24">${ICON[k]}</svg>${l}</button>`).join('');
  let h;
  if (ui.page && ui.page.type === 'exercise') h = vExercise(ui.page.id);
  else if (ui.page && ui.page.type === 'workout') h = vWorkoutDetail(ui.page.id);
  else h = { workout: vWorkout, history: vHistory, exercises: vExercises, body: vBody }[ui.tab]();
  $('#app').innerHTML = h;
}
const back = () => `<button class="ghost" data-act="back">‹ Back</button>`;

/* ---------- Workout tab ---------- */
function vWorkout() {
  const a = db.active;
  if (!a) return vHome();
  const cards = a.entries.map((e, ei) => {
    const prev = prevSets(e.exId);
    const rows = e.sets.map((s, si) => {
      const p = prev[si];
      return `<tr class="${s.done ? 'done' : ''}"><td class="n">${si + 1}</td>
        <td class="prev">${p ? `<span data-act="fillprev" data-ei="${ei}" data-si="${si}">${wStr(p.w)}×${p.r}</span>` : '–'}</td>
        <td><input inputmode="decimal" data-f="w" data-ei="${ei}" data-si="${si}" value="${s.w != null ? fmt(wDisp(s.w)) : ''}" placeholder="${p ? fmt(wDisp(p.w)) : ''}"></td>
        <td><input inputmode="numeric" data-f="r" data-ei="${ei}" data-si="${si}" value="${s.r != null ? s.r : ''}" placeholder="${p ? p.r : ''}"></td>
        <td><button class="check" data-act="toggle" data-ei="${ei}" data-si="${si}">✓</button></td></tr>`;
    }).join('');
    return `<div class="ex"><div class="row between"><div class="name grow" data-act="exdetail" data-id="${e.exId}">${esc(exName(e.exId))}</div>
      <button class="ghost" data-act="rmex" data-ei="${ei}">Remove</button></div>
      <table class="sets"><tr><th>SET</th><th>PREVIOUS</th><th>${wUnit().toUpperCase()}</th><th>REPS</th><th></th></tr>${rows}</table>
      <div class="row" style="margin-top:8px"><button class="sm grow" data-act="addset" data-ei="${ei}">+ Add set</button>
      ${e.sets.length > 1 ? `<button class="sm" data-act="rmset" data-ei="${ei}">− Remove set</button>` : ''}</div></div>`;
  }).join('');
  return `<div class="row between" style="margin-top:8px"><input id="wname" data-f="wname" value="${esc(a.name)}" style="font-weight:800;font-size:20px;background:none;padding:6px 0">
    <button class="good" data-act="finish">Finish</button></div>
    <div class="mute small" style="margin-bottom:12px">⏱ <span id="wtimer">${dur(Date.now() - a.start)}</span> · ${a.entries.reduce((n, e) => n + e.sets.filter(s => s.done).length, 0)} sets done</div>
    ${cards || '<div class="empty">Add your first exercise to get started</div>'}
    <button class="primary block" data-act="addex">+ Add exercise</button>
    <button class="danger block" data-act="cancelwk" style="margin-top:10px">Cancel workout</button>`;
}
function vHome() {
  const wk = weekly()[weekKey(Date.now())] || { sessions: 0, sets: 0, vol: 0 };
  const routines = db.routines.map(r => `<div class="item"><div class="grow"><div class="t">${esc(r.name)}</div>
    <div class="mute small">${r.entries.map(e => esc(exName(e.exId))).join(', ')}</div></div>
    <button class="sm primary" data-act="startroutine" data-id="${r.id}">Start</button>
    <button class="ghost" data-act="routinemenu" data-id="${r.id}">⋯</button></div>`).join('');
  return `<div class="row between"><h1>Workout</h1><button class="ghost" data-act="settings">⚙︎ Settings</button></div>
    <div class="stats"><div class="stat"><b>${wk.sessions}</b><span>Workouts this week</span></div>
    <div class="stat"><b>${wk.sets}</b><span>Sets</span></div><div class="stat"><b>${kfmt(wDisp(wk.vol))}</b><span>Volume (${wUnit()})</span></div></div>
    <button class="primary block" data-act="startempty" style="padding:15px;font-size:17px">Start empty workout</button>
    <h2>Routines</h2>${routines || '<div class="card mute small">No routines yet. Open any workout in History and tap “Save as routine”.</div>'}`;
}

/* ---------- History tab ---------- */
function vHistory() {
  const seg = `<div class="seg"><button class="${ui.hseg === 'log' ? 'on' : ''}" data-act="hseg" data-s="log">Workouts</button>
    <button class="${ui.hseg === 'week' ? 'on' : ''}" data-act="hseg" data-s="week">Week over week</button></div>`;
  if (ui.hseg === 'week') return `<h1>History</h1>${seg}${vWeekly()}`;
  const list = sortedWk().reverse().map(w => `<div class="item" data-act="wkdetail" data-id="${w.id}" style="display:block">
    <div class="row between"><div class="t">${esc(w.name)}</div><div class="mute small">${fmtDate(w.start, true)}</div></div>
    <div class="mute small">${dur(w.end - w.start)} · ${wkSets(w)} sets · ${kfmt(wDisp(wkVol(w)))} ${wUnit()}</div>
    <div class="small" style="margin-top:4px">${w.entries.map(e => esc(exName(e.exId))).join(' · ')}</div></div>`).join('');
  return `<h1>History</h1>${seg}${list || '<div class="empty">No workouts logged yet.<br>Finish a workout and it will show up here.</div>'}`;
}
function vWeekly() {
  const m = weekly(), items = [], rows = [];
  let k = weekKey(Date.now());
  for (let i = 0; i < 12; i++) {
    const d = new Date(k); items.unshift({ k, label: `${d.getMonth() + 1}/${d.getDate()}`, v: wDisp((m[k] || { vol: 0 }).vol) });
    d.setDate(d.getDate() - 7); k = d.getTime();
  }
  const keys = items.map(i => i.k);
  keys.slice().reverse().forEach(k => {
    const cur = m[k], prv = m[keys[keys.indexOf(k) - 1]];
    if (!cur) return;
    rows.push(`<tr><td>${fmtDate(k)}</td><td>${cur.sessions}</td><td>${cur.sets}</td><td>${kfmt(wDisp(cur.vol))}</td><td>${prv ? pct(cur.vol, prv.vol) : ''}</td></tr>`);
  });
  return `<div class="card"><div class="small mute" style="margin-bottom:6px">Weekly volume (${wUnit()}) — last 12 weeks</div>${barChart(items, kfmt)}</div>
    <div class="card"><table class="t"><tr><th>Week of</th><th>Workouts</th><th>Sets</th><th>Volume</th><th>vs prev</th></tr>${rows.join('') || ''}</table>
    ${rows.length ? '' : '<div class="empty small">Nothing logged yet</div>'}</div>`;
}
function vWorkoutDetail(id) {
  const w = db.workouts.find(x => x.id === id);
  if (!w) { ui.page = null; return vHistory(); }
  const ents = w.entries.map(e => `<div class="card"><div class="row between"><div class="t" style="color:var(--accent);font-weight:700" data-act="exdetail" data-id="${e.exId}">${esc(exName(e.exId))}</div>
    ${isPR(w, e) ? '<span class="badge pr">🏆 PR</span>' : ''}</div>
    ${e.sets.map((s, i) => `<div class="row between small" style="padding:4px 0"><span class="mute">Set ${i + 1}</span><span>${wStr(s.w)} ${wUnit()} × ${s.r}</span></div>`).join('')}</div>`).join('');
  return `${back()}<h1>${esc(w.name)}</h1><div class="mute small" style="margin:-8px 0 12px">${fmtDate(w.start, true)} · ${dur(w.end - w.start)} · ${kfmt(wDisp(wkVol(w)))} ${wUnit()} volume</div>${ents}
    <div class="grid2"><button data-act="repeat" data-id="${w.id}">Repeat workout</button><button data-act="saveroutine" data-id="${w.id}">Save as routine</button></div>
    <button class="danger block" data-act="delwk" data-id="${w.id}" style="margin-top:10px">Delete workout</button>`;
}

/* ---------- Exercises tab ---------- */
function vExercises() {
  const chips = ['All', ...MUSCLES].map(m => `<div class="chip ${ui.exM === m ? 'on' : ''}" data-act="exm" data-m="${m}">${m}</div>`).join('');
  return `<div class="row between"><h1>Exercises</h1><button class="ghost" data-act="newex" data-from="tab">+ New</button></div>
    <input class="search" id="exq" placeholder="Search exercises" value="${esc(ui.exQ)}"><div class="chips">${chips}</div><div id="exlist">${exList(ui.exQ, ui.exM, 'exdetail')}</div>`;
}
function exList(q, m, act, sel) {
  q = q.trim().toLowerCase();
  const l = db.exercises.filter(e => (m === 'All' || e.muscle === m) && e.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  return l.map(e => `<div class="item" data-act="${act}" data-id="${e.id}"><div class="grow"><div class="t">${esc(e.name)}</div><div class="mute small">${e.muscle}${e.custom ? ' · custom' : ''}</div></div>
    ${sel ? (sel.has(e.id) ? '<span style="color:var(--accent2);font-size:20px">✓</span>' : '') : '<span class="mute">›</span>'}</div>`).join('') || '<div class="empty">No exercises found</div>';
}
function vExercise(id) {
  const ex = exById(id);
  if (!ex) { ui.page = null; return vExercises(); }
  const ses = exSessions(id), M = ui.exMetric;
  const val = s => M === 'top' ? wDisp(s.top) : M === 'e1' ? wDisp(s.e1) : wDisp(s.vol);
  const pts = ses.map(s => ({ t: s.t, y: val(s) }));
  const bestTop = ses.length ? Math.max(...ses.map(s => s.top)) : null, best1 = ses.length ? Math.max(...ses.map(s => s.e1)) : null;
  const wm = weekly(id), wks = Object.keys(wm).map(Number).sort((a, b) => b - a);
  const rows = wks.map(k => { const p = wm[k - 7 * 864e5] || wm[wks[wks.indexOf(k) + 1]]; const o = wm[k];
    return `<tr><td>${fmtDate(k)}</td><td>${o.sets}</td><td>${o.reps}</td><td>${wStr(o.top)}</td><td>${kfmt(wDisp(o.vol))}</td><td>${p ? pct(o.vol, p.vol) : ''}</td></tr>`; }).join('');
  const hist = ses.slice().reverse().map(s => `<div class="card" data-act="wkdetail" data-id="${s.wid}"><div class="mute small">${fmtDate(s.t, true)}</div>
    ${s.sets.map((x, i) => `<div class="row between small" style="padding:3px 0"><span class="mute">Set ${i + 1}</span><span>${wStr(x.w)} ${wUnit()} × ${x.r}</span></div>`).join('')}</div>`).join('');
  const chips = [['e1', 'Est. 1RM'], ['top', 'Top weight'], ['vol', 'Volume']].map(([k, l]) => `<div class="chip ${M === k ? 'on' : ''}" data-act="exmetric" data-k="${k}">${l}</div>`).join('');
  return `<div class="row between">${back()}<button class="ghost" data-act="exedit" data-id="${id}">Edit</button></div><h1>${esc(ex.name)}</h1>
    <div class="mute small" style="margin:-8px 0 12px">${ex.muscle}</div>
    <div class="stats"><div class="stat"><b>${ses.length}</b><span>Sessions</span></div><div class="stat"><b>${bestTop == null ? '–' : wStr(bestTop)}</b><span>Best weight (${wUnit()})</span></div>
    <div class="stat"><b>${best1 == null ? '–' : wStr(best1)}</b><span>Est. 1RM (${wUnit()})</span></div></div>
    <div class="chips">${chips}</div><div class="card">${lineChart(pts, v => kfmt(v))}</div>
    ${rows ? `<h2>Week over week</h2><div class="card"><table class="t"><tr><th>Week of</th><th>Sets</th><th>Reps</th><th>Top</th><th>Vol</th><th>vs prev</th></tr>${rows}</table></div>` : ''}
    <h2>History</h2>${hist || '<div class="empty small">No sets logged for this exercise yet</div>'}`;
}

/* ---------- Body tab ---------- */
const bConv = (k, v) => k === 'weight' ? wDisp(v) : k === 'bodyfat' ? v : lenDisp(v);
const bUnit = k => k === 'weight' ? wUnit() : k === 'bodyfat' ? '%' : lUnit();
function vBody() {
  const sorted = db.body.slice().sort((a, b) => a.date < b.date ? -1 : 1);
  const cur = db.body.find(b => b.date === ui.bDate) || {};
  const last = k => { for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i][k] != null) return sorted[i][k]; return null; };
  const inp = d => `<div><label class="f">${d.label} (${bUnit(d.k)})</label><input inputmode="decimal" id="b_${d.k}" value="${cur[d.k] != null ? fmt(bConv(d.k, cur[d.k])) : ''}"
    placeholder="${last(d.k) != null ? fmt(bConv(d.k, last(d.k))) : ''}"></div>`;
  const form = `<div class="card"><label class="f">Date</label><input type="date" id="b_date" value="${ui.bDate}" max="${dkey()}" style="margin-bottom:10px">
    <div class="grid2">${inp(BODY[0])}${inp(BODY[1])}</div><div class="small mute" style="margin:12px 0 6px">Measurements (optional)</div>
    <div class="grid3">${BODY.slice(2).map(inp).join('')}</div>
    <button class="primary block" data-act="savebody" style="margin-top:12px">${db.body.find(b => b.date === ui.bDate) ? 'Update entry' : 'Save entry'}</button></div>`;
  const m = BODY.find(b => b.k === ui.bMetric), since = ui.bRange ? Date.now() - ui.bRange * 864e5 : 0;
  const pts = sorted.filter(b => b[m.k] != null && keyTs(b.date) >= since).map(b => ({ t: keyTs(b.date), y: bConv(m.k, b[m.k]) }));
  const mchips = BODY.map(b => `<div class="chip ${ui.bMetric === b.k ? 'on' : ''}" data-act="bmetric" data-k="${b.k}">${b.label}</div>`).join('');
  const rchips = [[30, '30d'], [90, '90d'], [365, '1y'], [0, 'All']].map(([d, l]) => `<div class="chip ${ui.bRange === d ? 'on' : ''}" data-act="brange" data-d="${d}">${l}</div>`).join('');
  let sum = '';
  if (pts.length) {
    const d = pts[pts.length - 1].y - pts[0].y;
    sum = `<div class="stats"><div class="stat"><b>${fmt(pts[pts.length - 1].y)}</b><span>Latest (${bUnit(m.k)})</span></div>
      <div class="stat"><b class="${d === 0 ? '' : d < 0 ? 'up' : 'dn'}">${d > 0 ? '+' : ''}${fmt(d)}</b><span>Change</span></div>
      <div class="stat"><b>${fmt(pts.reduce((a, p) => a + p.y, 0) / pts.length)}</b><span>Average</span></div></div>`;
  }
  const list = sorted.slice().reverse().slice(0, 60).map(b => `<div class="item"><div class="grow" data-act="loadbody" data-d="${b.date}"><div class="t">${fmtDate(keyTs(b.date), true)}</div>
    <div class="mute small">${BODY.filter(x => b[x.k] != null).map(x => `${x.label} ${fmt(bConv(x.k, b[x.k]))}`).join(' · ')}</div></div>
    <button class="ghost" data-act="delbody" data-d="${b.date}" style="color:var(--danger)">✕</button></div>`).join('');
  return `<h1>Body</h1>${form}<div class="chips">${mchips}</div><div class="chips">${rchips}</div>${sum}
    <div class="card">${lineChart(pts, v => fmt(v))}</div><h2>Log</h2>${list || '<div class="empty small">No entries yet</div>'}`;
}
function saveBody() {
  const date = $('#b_date').value || dkey(), e = { date };
  BODY.forEach(d => {
    const v = num($('#b_' + d.k).value);
    if (v != null && v > 0) e[d.k] = d.k === 'weight' ? wParse(v) : d.k === 'bodyfat' ? v : lenParse(v);
  });
  if (Object.keys(e).length === 1) return toast('Enter at least one value');
  db.body = db.body.filter(b => b.date !== date); db.body.push(e); ui.bDate = date; save(); render(); toast('Saved ✓');
}

/* ---------- sheets ---------- */
function openSheet(h) { const s = $('#sheet'); s.innerHTML = `<div class="panel"><div class="grab"></div>${h}</div>`; s.classList.remove('hidden'); }
function closeSheet() { $('#sheet').classList.add('hidden'); $('#sheet').innerHTML = ''; pick = null; }

function openPicker(cb) { pick = { sel: new Set(), cb, q: '', m: 'All' }; drawPicker(); }
function drawPicker() {
  const chips = ['All', ...MUSCLES].map(m => `<div class="chip ${pick.m === m ? 'on' : ''}" data-act="pickm" data-m="${m}">${m}</div>`).join('');
  openSheet(`<div class="row between"><h2 style="margin:0">Add exercises</h2><button class="ghost" data-act="closesheet">Cancel</button></div>
    <input class="search" id="pq" placeholder="Search" value="${esc(pick.q)}" style="margin-top:10px"><div class="chips">${chips}</div>
    <div id="plist">${exList(pick.q, pick.m, 'picktoggle', pick.sel)}</div>
    <button class="primary block" data-act="pickdone" id="pdone">Add ${pick.sel.size ? '(' + pick.sel.size + ')' : ''}</button>
    <button class="block" data-act="newex" data-from="picker" style="margin-top:8px">+ Create new exercise</button>`);
}
function exForm(ex) {
  newExFrom = newExFrom || 'tab';
  openSheet(`<h2 style="margin-top:0">${ex ? 'Edit exercise' : 'New exercise'}</h2><label class="f">Name</label><input id="nx_name" value="${esc(ex ? ex.name : '')}" placeholder="e.g. Cable Lateral Raise">
    <label class="f" style="margin-top:10px">Muscle group</label><select id="nx_m">${MUSCLES.map(m => `<option ${ex && ex.muscle === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
    <button class="primary block" data-act="savenx" data-id="${ex ? ex.id : ''}" style="margin-top:14px">Save</button>
    ${ex && ex.custom && !exSessions(ex.id).length ? `<button class="danger block" data-act="delex" data-id="${ex.id}">Delete exercise</button>` : ''}
    <button class="block" data-act="${newExFrom === 'picker' ? 'repick' : 'closesheet'}" style="margin-top:8px">Cancel</button>`);
}
function settingsSheet() {
  openSheet(`<div class="row between"><h2 style="margin:0">Settings</h2><button class="ghost" data-act="closesheet">Done</button></div>
    <label class="f" style="margin-top:14px">Units</label><div class="seg"><button class="${isLb() ? 'on' : ''}" data-act="unit" data-u="lb">lb / in</button><button class="${!isLb() ? 'on' : ''}" data-act="unit" data-u="kg">kg / cm</button></div>
    <label class="f">Rest timer</label><select id="s_rest">${[30, 45, 60, 90, 120, 150, 180, 240].map(s => `<option value="${s}" ${db.settings.rest === s ? 'selected' : ''}>${s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60 ? s % 60 + 's' : '') : s + 's'}</option>`).join('')}</select>
    <h2>Backup</h2><div class="mute small" style="margin-bottom:8px">Your data lives only on this phone. Export a backup now and then and save it to Files / iCloud Drive.</div>
    <div class="small" style="margin-bottom:8px">Last backup: <b>${db.settings.lastBackup ? fmtDate(db.settings.lastBackup, true) : 'never'}</b></div>
    <div class="grid2"><button data-act="export">Download backup</button><button data-act="import">Import backup</button></div>
    <button class="block" data-act="share" style="margin-top:8px">Share / save to Files…</button>
    <input type="file" id="impfile" accept=".json,application/json" class="hidden">
    <button class="danger block" data-act="reset" style="margin-top:18px">Erase all data</button>`);
}

/* ---------- rest timer ---------- */
function startRest(sec) {
  rest = { end: Date.now() + sec * 1000 };
  $('#rest').innerHTML = `<div style="font-size:12px;opacity:.85">REST</div><div class="time" id="rtime">${dur(sec * 1000)}</div>
    <button data-act="restadj" data-s="-15">−15</button><button data-act="restadj" data-s="15">+15</button><button data-act="restskip">Skip</button>`;
  $('#rest').classList.add('on');
}
function stopRest() { rest = null; $('#rest').classList.remove('on'); }
function beep() { try { const c = new (window.AudioContext || window.webkitAudioContext)(), o = c.createOscillator(); o.connect(c.destination); o.frequency.value = 880; o.start(); setTimeout(() => { o.stop(); c.close(); }, 300); } catch (e) {} }
setInterval(() => {
  const t = $('#wtimer'); if (t && db.active) t.textContent = dur(Date.now() - db.active.start);
  if (rest) {
    const left = rest.end - Date.now();
    if (left <= 0) { stopRest(); toast('Rest over — next set 💪'); beep(); } else { const r = $('#rtime'); if (r) r.textContent = dur(left + 999); }
  }
}, 500);

/* ---------- actions ---------- */
function newEntry(exId) {
  const n = prevSets(exId).length || 3;
  return { exId, sets: Array.from({ length: n }, () => ({ w: null, r: null, done: false })) };
}
function startWorkout(name, entries) { db.active = { id: uid(), name, start: Date.now(), entries }; save(); ui.tab = 'workout'; ui.page = null; render(); }
function finishWorkout() {
  const a = db.active;
  const entries = a.entries.map(e => ({ exId: e.exId, sets: e.sets.filter(s => s.done).map(s => ({ w: s.w || 0, r: s.r })) })).filter(e => e.sets.length);
  if (!entries.length) {
    if (confirm('No completed sets. Discard this workout?')) { db.active = null; stopRest(); save(); render(); }
    return;
  }
  if (a.entries.some(e => e.sets.some(s => !s.done)) && !confirm('Some sets are not checked off and will be dropped. Finish anyway?')) return;
  db.workouts.push({ id: a.id, name: a.name || 'Workout', start: a.start, end: Date.now(), entries });
  db.active = null; stopRest(); save(); ui.tab = 'history'; ui.hseg = 'log'; render(); toast('Workout saved 🎉');
}
function backupFile() {
  const name = `liftlog-backup-${dkey()}.json`;
  return { name, blob: new Blob([JSON.stringify(db, null, 1)], { type: 'application/json' }) };
}
function markBackup() { db.settings.lastBackup = Date.now(); save(); settingsSheet(); }
function exportData() { // direct download to the device
  const { name, blob } = backupFile(), url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  markBackup(); toast('Backup downloaded');
}
function shareData() { // iOS share sheet → Save to Files / iCloud / AirDrop
  const { name, blob } = backupFile(), file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) navigator.share({ files: [file], title: name }).then(markBackup).catch(() => {});
  else exportData();
}

document.addEventListener('click', ev => {
  if (ev.target.id === 'sheet') return closeSheet();
  const el = ev.target.closest('[data-act]'); if (!el) return;
  const d = el.dataset, a = db.active;
  const ei = +d.ei, si = +d.si;
  switch (d.act) {
    case 'tab': ui.tab = d.t; ui.page = null; render(); scrollTo(0, 0); break;
    case 'back': ui.page = null; render(); break;
    case 'settings': settingsSheet(); break;
    case 'closesheet': closeSheet(); break;
    case 'startempty': startWorkout('Workout', []); break;
    case 'startroutine': { const r = db.routines.find(x => x.id === d.id); startWorkout(r.name, r.entries.map(e => ({ exId: e.exId, sets: Array.from({ length: e.sets }, () => ({ w: null, r: null, done: false })) }))); break; }
    case 'routinemenu': { const r = db.routines.find(x => x.id === d.id);
      openSheet(`<h2 style="margin-top:0">${esc(r.name)}</h2><button class="block" data-act="rnroutine" data-id="${r.id}">Rename</button>
      <button class="danger block" data-act="delroutine" data-id="${r.id}" style="margin-top:8px">Delete routine</button><button class="block" data-act="closesheet" style="margin-top:8px">Close</button>`); break; }
    case 'rnroutine': { const r = db.routines.find(x => x.id === d.id), n = prompt('Routine name', r.name); if (n && n.trim()) { r.name = n.trim(); save(); } closeSheet(); render(); break; }
    case 'delroutine': if (confirm('Delete this routine?')) { db.routines = db.routines.filter(x => x.id !== d.id); save(); } closeSheet(); render(); break;
    case 'addex': openPicker(ids => { ids.forEach(id => a.entries.push(newEntry(id))); save(); render(); }); break;
    case 'rmex': if (confirm('Remove this exercise from the workout?')) { a.entries.splice(ei, 1); save(); render(); } break;
    case 'addset': { const s = a.entries[ei].sets, l = s[s.length - 1]; s.push({ w: l ? l.w : null, r: l ? l.r : null, done: false }); save(); render(); break; }
    case 'rmset': a.entries[ei].sets.pop(); save(); render(); break;
    case 'fillprev': { const p = prevSets(a.entries[ei].exId)[si], s = a.entries[ei].sets[si]; s.w = p.w; s.r = p.r; save(); render(); break; }
    case 'toggle': {
      const e = a.entries[ei], s = e.sets[si], p = prevSets(e.exId)[si];
      if (!s.done) {
        if (s.r == null && p) s.r = p.r; if (s.w == null && p) s.w = p.w;
        if (s.r == null || s.r <= 0) return toast('Enter reps first');
        s.done = true; startRest(db.settings.rest);
      } else s.done = false;
      save(); render(); break;
    }
    case 'finish': finishWorkout(); break;
    case 'cancelwk': if (confirm('Cancel and discard this workout?')) { db.active = null; stopRest(); save(); render(); } break;
    case 'restadj': if (rest) rest.end += +d.s * 1000; break;
    case 'restskip': stopRest(); break;
    case 'hseg': ui.hseg = d.s; render(); break;
    case 'wkdetail': ui.page = { type: 'workout', id: d.id }; render(); scrollTo(0, 0); break;
    case 'exdetail': ui.page = { type: 'exercise', id: d.id }; render(); scrollTo(0, 0); break;
    case 'exm': ui.exM = d.m; render(); break;
    case 'exmetric': ui.exMetric = d.k; render(); break;
    case 'exedit': newExFrom = 'tab'; exForm(exById(d.id)); break;
    case 'newex': newExFrom = d.from; exForm(null); break;
    case 'savenx': {
      const name = $('#nx_name').value.trim(), m = $('#nx_m').value;
      if (!name) return toast('Name required');
      if (d.id) { const x = exById(d.id); x.name = name; x.muscle = m; }
      else { const x = { id: uid(), name, muscle: m, custom: true }; db.exercises.push(x); if (pick) pick.sel.add(x.id); }
      save(); if (pick && newExFrom === 'picker') drawPicker(); else { closeSheet(); render(); } toast('Saved ✓'); break;
    }
    case 'repick': drawPicker(); break;
    case 'delex': if (confirm('Delete this exercise?')) { db.exercises = db.exercises.filter(x => x.id !== d.id); save(); closeSheet(); ui.page = null; render(); } break;
    case 'pickm': pick.m = d.m; drawPicker(); break;
    case 'picktoggle': pick.sel.has(d.id) ? pick.sel.delete(d.id) : pick.sel.add(d.id); $('#plist').innerHTML = exList(pick.q, pick.m, 'picktoggle', pick.sel); $('#pdone').textContent = 'Add ' + (pick.sel.size ? '(' + pick.sel.size + ')' : ''); break;
    case 'pickdone': { const ids = [...pick.sel], cb = pick.cb; closeSheet(); if (ids.length) cb(ids); break; }
    case 'repeat': { const w = db.workouts.find(x => x.id === d.id); startWorkout(w.name, w.entries.map(e => ({ exId: e.exId, sets: e.sets.map(() => ({ w: null, r: null, done: false })) }))); break; }
    case 'saveroutine': { const w = db.workouts.find(x => x.id === d.id), n = prompt('Routine name', w.name);
      if (n && n.trim()) { db.routines.push({ id: uid(), name: n.trim(), entries: w.entries.map(e => ({ exId: e.exId, sets: e.sets.length })) }); save(); toast('Routine saved'); } break; }
    case 'delwk': if (confirm('Delete this workout permanently?')) { db.workouts = db.workouts.filter(x => x.id !== d.id); save(); ui.page = null; render(); } break;
    case 'savebody': saveBody(); break;
    case 'loadbody': ui.bDate = d.d; render(); scrollTo(0, 0); break;
    case 'delbody': if (confirm('Delete this entry?')) { db.body = db.body.filter(b => b.date !== d.d); save(); render(); } break;
    case 'bmetric': ui.bMetric = d.k; render(); break;
    case 'brange': ui.bRange = +d.d; render(); break;
    case 'unit': db.settings.unit = d.u; save(); settingsSheet(); render(); break;
    case 'export': exportData(); break;
    case 'share': shareData(); break;
    case 'import': $('#impfile').click(); break;
    case 'reset': if (confirm('Erase ALL workouts, exercises and body data? This cannot be undone.') && confirm('Really erase everything?')) { db = seed(); save(); closeSheet(); ui.page = null; render(); } break;
  }
});

document.addEventListener('input', ev => {
  const t = ev.target, d = t.dataset;
  if (d.f === 'wname') { db.active.name = t.value; save(); }
  else if (d.f === 'w' || d.f === 'r') {
    const s = db.active.entries[+d.ei].sets[+d.si], v = num(t.value);
    s[d.f] = v == null ? null : d.f === 'w' ? wParse(v) : Math.round(v); save();
  } else if (t.id === 'exq') { ui.exQ = t.value; $('#exlist').innerHTML = exList(ui.exQ, ui.exM, 'exdetail'); }
  else if (t.id === 'pq' && pick) { pick.q = t.value; $('#plist').innerHTML = exList(pick.q, pick.m, 'picktoggle', pick.sel); }
});
document.addEventListener('change', ev => {
  const t = ev.target;
  if (t.id === 'b_date' && t.value) { ui.bDate = t.value; render(); }
  else if (t.id === 's_rest') { db.settings.rest = +t.value; save(); }
  else if (t.id === 'impfile' && t.files[0]) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!Array.isArray(d.exercises) || !Array.isArray(d.workouts)) throw 0;
        if (!confirm(`Replace everything on this phone with the backup (${d.workouts.length} workouts, ${(d.body || []).length} body entries)?`)) return;
        db = Object.assign(seed(), d); save(); closeSheet(); ui.page = null; render(); toast('Backup restored ✓');
      } catch (e) { toast('That file is not a valid backup'); }
    };
    r.readAsText(t.files[0]);
  }
});

render();
if (db.active) $('#rest').classList.remove('on');
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
