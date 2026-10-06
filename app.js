/* Mogzy kiosk. Face matching runs on this device; the server only records proven events. */
"use strict";
const CFG = (typeof window !== "undefined" && window.MOGZY) || { url: "", key: "" }, FN = CFG.url + "/functions/v1/kiosk";
const $ = (id) => (typeof document !== "undefined" ? document.getElementById(id) : null);
const LS = typeof localStorage === "undefined" ? {} : {
  get(k, d) { try { const v = localStorage.getItem("mogzy." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("mogzy." + k, JSON.stringify(v)); } catch (e) { console.warn(e); } },
  del(k) { try { localStorage.removeItem("mogzy." + k); } catch {} },
};

/* ---------- pure helpers (also unit-tested) ---------- */
function dist(a, b) { let s = 0; for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }
const MARGIN = 0.07, UNKNOWN_GAP = 0.04;
/* Distance of one face to one employee = closest enrolled template (poses differ, so the best pose is the fair one). */
function empDist(desc, e) { let d = 9; for (const t of e.templates || []) d = Math.min(d, dist(desc, t)); return d; }
function bestMatch(desc, emps) {
  let best = null, bd = 9, sd = 9;
  for (const e of emps) { const d = empDist(desc, e); if (d < bd) { sd = bd; bd = d; best = e; } else if (d < sd) sd = d; }
  return { emp: best, dist: bd, second: sd };
}
function identify(desc, emps, minScore) {
  const m = bestMatch(desc, emps);
  return m.emp && m.dist <= 1 - minScore && m.second - m.dist >= MARGIN ? { emp: m.emp, dist: m.dist } : null;
}
/* Several frames vote: "known" needs >=75% of them to agree on one employee, "unknown" needs >=75% clearly far from everyone. */
function verdict(samples, emps, minScore) {
  const thr = 1 - minScore, n = samples.length, need = Math.ceil(n * 0.75);
  const per = samples.map((d) => bestMatch(d, emps));
  const votes = {};
  per.forEach((m) => { if (m.emp && m.dist <= thr && m.second - m.dist >= MARGIN) (votes[m.emp.id] = votes[m.emp.id] || []).push(m); });
  const top = Object.values(votes).sort((x, y) => y.length - x.length)[0];
  if (top && top.length >= need) return { kind: "known", emp: top[0].emp, dist: top.reduce((a, m) => a + m.dist, 0) / top.length };
  if (per.filter((m) => m.dist > thr + UNKNOWN_GAP).length >= need) return { kind: "unknown" };
  return { kind: "unsure" };
}
function yaw(lm) { const nose = lm[30].x, l = lm[0].x, r = lm[16].x; return (nose - l) / (r - l); }   // ~0.5 facing camera
function ear(lm, o) { const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
  return (d(o + 1, o + 5) + d(o + 2, o + 4)) / (2 * d(o, o + 3)); }
function eyeOpen(lm) { return (ear(lm, 36) + ear(lm, 42)) / 2; }
const money = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
if (typeof module !== "undefined") module.exports = { dist, identify, bestMatch, verdict, yaw, eyeOpen };
if (typeof window === "undefined" || !window.document) { /* node test: stop here */ }
else (function main() {

/* ---------- state ---------- */
let cache = LS.get("cache", null);              // last sync from the server
let clockOffset = LS.get("offset", 0);          // server time - device time
let mode = "load", stream = null, busy = false, cur = null, idleTimer = null;
const now = () => new Date(Date.now() + clockOffset);
const opts = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (id) => { document.querySelectorAll(".screen").forEach((s) => s.classList.remove("on")); $("s-" + id).classList.add("on"); };

/* ---------- network & offline queues ---------- */
async function api(action, extra = {}) {
  const r = await fetch(FN, { method: "POST", headers: { "content-type": "application/json", apikey: CFG.key, "x-device-token": LS.get("token", "") },
    body: JSON.stringify({ action, ...extra }) });
  if (r.status === 401) { const e = new Error("device"); e.code = 401; throw e; }
  if (r.status === 403) { LS.set("susp", true); const e = new Error("suspended"); e.code = 403; throw e; }
  if (!r.ok) throw new Error("http " + r.status);
  LS.set("susp", false);
  return r.json();
}
const qE = () => LS.get("qe", []), qR = () => LS.get("qr", []);
function netBadge(online) {
  if (LS.get("susp", false)) { $("netdot").className = "dot off"; $("netmsg").textContent = "اشتراك الشركة موقوف — تواصل مع الإدارة"; return; }
  const n = qE().length + qR().length;
  $("netdot").className = "dot" + (online ? "" : " off");
  $("netmsg").textContent = online ? (n ? `جاري إرسال ${n}…` : "متصل") : (n ? `بدون إنترنت · ${n} بانتظار الإرسال` : "بدون إنترنت · يعمل عادي");
}
async function flush() {
  try {
    const ev = qE();
    if (ev.length) { const r = await api("events", { items: ev }); const done = new Set([...r.accepted, ...r.rejected]);
      if (r.rejected.length) LS.set("rej", [...LS.get("rej", []), ...ev.filter((x) => r.rejected.includes(x.client_event_id))]);
      LS.set("qe", qE().filter((x) => !done.has(x.client_event_id))); }
    const rq = qR();
    if (rq.length) { const r = await api("requests", { items: rq }); const done = new Set([...r.accepted, ...r.rejected]);
      LS.set("qr", qR().filter((x) => !done.has(x.client_request_id))); }
    netBadge(true); return true;
  } catch (e) { if (e.code === 401) { LS.del("token"); location.reload(); } netBadge(false); return false; }
}
async function sync() {
  if (!(await flush())) return;
  try {
    const d = await api("sync");
    clockOffset = new Date(d.server_time) - new Date(); LS.set("offset", clockOffset);
    // keep punches that are still waiting to be sent when refreshing "who is inside"
    const pend = qE(); d.employees.forEach((e) => { const p = pend.filter((x) => x.employee_id === e.id).pop();
      if (p) e.open_since = p.kind === "in" ? p.occurred_at : null; });
    cache = d; LS.set("cache", d); netBadge(true);
  } catch (e) { netBadge(false); }
}

/* ---------- camera & models ---------- */
async function startCam(el) {
  if (!stream) stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 640, height: 480 }, audio: false });
  el.srcObject = stream; await el.play().catch(() => {});
}
async function pickBackend() {
  for (const b of ["webgl", "cpu"]) { try { if (await faceapi.tf.setBackend(b)) { await faceapi.tf.ready(); return b; } } catch (e) { console.warn(b, e); } }
  throw new Error("no tf backend");
}
async function loadModels() {
  window.__backend = await pickBackend();
  await faceapi.nets.tinyFaceDetector.loadFromUri(".");
  await faceapi.nets.faceLandmark68Net.loadFromUri(".");
  await faceapi.nets.faceRecognitionNet.loadFromUri(".");
}
const detect = (el, withDesc) => { const t = faceapi.detectAllFaces(el, opts()).withFaceLandmarks(); return withDesc ? t.withFaceDescriptors() : t; };

/* ---------- scan loop ---------- */
const setStatus = (t, h, cls = "") => { $("status").textContent = t; $("status").className = "status " + cls; if (h !== undefined) $("hint").textContent = h; };
const oval = (c) => { $("oval").className = "oval " + (c || ""); $("oval").parentElement.classList.toggle("bad", c === "bad"); };
function tickClock() {
  const d = now(); $("clock").textContent = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  $("date").textContent = d.toLocaleDateString("ar-EG", { weekday: "long", day: "numeric", month: "long" });
}
setInterval(tickClock, 1000);

let scanTimer = null;
const sc = { samples: [], unsure: 0, hold: 0, goneAt: 0 };
const scReset = () => { sc.samples = []; sc.unsure = 0; };
const idleUI = () => { oval(); setStatus("قف أمام الكاميرا", "انظر للكاميرا مباشرة وسيتعرف عليك الجهاز."); };
let lumCv = null;
function tooDark(v) {                            // average brightness of the camera picture
  try { lumCv = lumCv || document.createElement("canvas"); lumCv.width = 32; lumCv.height = 24;
    const c = lumCv.getContext("2d", { willReadFrequently: true }); c.drawImage(v, 0, 0, 32, 24);
    const d = c.getImageData(0, 0, 32, 24).data; let t = 0; for (let i = 0; i < d.length; i += 4) t += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    return t / (d.length / 4) < 38; } catch { return false; }
}
/* A stranger gets ONE steady red message (no flicker) that stays until they walk away. */
function showUnknown() {
  oval("bad"); setStatus("وجهك غير مسجّل", "اطلب من الإدارة تسجيل وجهك أولاً.", "bad");
  sc.hold = Date.now(); sc.goneAt = 0; scReset();
}
const usable = (res, v) => res.length === 1 && res[0].detection.box.width >= v.videoWidth * 0.22 && (() => { const y = yaw(res[0].landmarks.positions); return y >= 0.36 && y <= 0.64; })();
/* Collect a descriptor from the current frame; every 4th call returns a verdict. */
async function readFace(v) {
  const full = await detect(v, true);
  if (full.length === 1) sc.samples.push(full[0].descriptor);
  if (sc.samples.length < 4) return null;
  const vd = verdict(sc.samples, cache.employees, Number(cache.settings.min_match_score)); sc.samples = [];
  return vd;
}
async function scanLoop() {
  if (mode !== "scan" || busy) return;
  busy = true;
  let next = 140;
  try {
    const v = $("video"), res = await detect(v, false), t = Date.now();
    if (!cache || !cache.employees.some((e) => (e.templates || []).length)) { setStatus("لا توجد وجوه مسجلة بعد", "اطلب من المدير تسجيل الوجوه."); oval(); }
    else if (sc.hold) {                                          // red message is on screen: it stays until the person walks away
      if (res.length === 0) { sc.goneAt = sc.goneAt || t; sc.miss = (sc.miss || 0) + 1; if (t - sc.goneAt > 2500 && sc.miss >= 4) { sc.hold = 0; sc.goneAt = 0; sc.miss = 0; scReset(); idleUI(); } }
      else {
        sc.goneAt = 0; sc.miss = 0;
        if (usable(res, v)) {                                    // quiet re-check (no flicker) in case the first verdict was wrong
          const vd = await readFace(v);
          if (vd && vd.kind === "known") { sc.hold = 0; scReset(); await challenge(vd.emp, vd.dist); busy = false; scanTimer = setTimeout(scanLoop, 220); return; }
        }
      }
    }
    else if (res.length === 0) { scReset(); if (tooDark(v)) { oval(); setStatus("الإضاءة ضعيفة", "زوّد الإضاءة أمام الجهاز.", "warn"); } else idleUI(); }
    else if (res.length > 1) { setStatus("وجه واحد فقط من فضلك", "ليقف شخص واحد أمام الجهاز."); oval(); scReset(); }
    else if (res[0].detection.box.width < v.videoWidth * 0.22) { setStatus("اقترب قليلاً", ""); oval(); scReset(); }
    else if (!usable(res, v)) { setStatus("انظر للكاميرا مباشرة", ""); oval(); scReset(); }
    else {
      oval("ok"); if (!sc.samples.length && !sc.unsure) setStatus("جارٍ التعرف…", "");
      const vd = await readFace(v);
      if (vd) {
        if (vd.kind === "known") { sc.unsure = 0; await challenge(vd.emp, vd.dist); busy = false; scanTimer = setTimeout(scanLoop, 220); return; }
        if (vd.kind === "unknown") showUnknown();
        else if (++sc.unsure >= 2) setStatus("لم أتأكد من هويتك", "انظر مباشرة للكاميرا وبإضاءة أفضل.", "warn");
      }
    }
  } catch (e) { console.warn(e); }
  busy = false;
  scanTimer = setTimeout(scanLoop, next);
}

/* ---------- liveness: random head turn / blink, then re-verify the same person ---------- */
const MOTION_MIN = 0.004;
const SNAPSHOTS = false; // per-punch photo + AI review: paused until a stronger method is chosen
const CH = {
  turn_right: { text: "حرّك رأسك ببطء لليمين", test: (lm) => yaw(lm) < 0.38 },
  turn_left:  { text: "حرّك رأسك ببطء لليسار", test: (lm) => yaw(lm) > 0.62 },
  blink:      { text: "أغمض عينيك ثم افتحهما", test: null },
};
const pick2 = () => { const all = ["turn_right", "turn_left", "blink"].sort(() => Math.random() - 0.5); return all.slice(0, 2); };
/* One liveness step: wait for a neutral face first, then the asked movement. */
async function doStep(name, ms = 8000) {
  const t0 = Date.now(); let neutral = false, open = false, hits = 0;
  while (Date.now() - t0 < ms) {
    const r = await detect($("video"), false);
    if (r.length !== 1) { await sleep(80); continue; }
    const lm = r[0].landmarks.positions, y = yaw(lm);
    if (name === "blink") { const e = eyeOpen(lm); if (e > 0.26) open = true; if (open && e < 0.19) return true; }
    else { if (y > 0.44 && y < 0.56) neutral = true; if (neutral && CH[name].test(lm)) { if (++hits >= 2) return true; } else hits = 0; }
    await sleep(60);
  }
  return false;
}
/* Same person still in front of the camera? (strict, several frames) */
async function reverify(emp, minScore, ms = 5000) {
  const t1 = Date.now(), got = [];
  while (Date.now() - t1 < ms && got.length < 3) {
    const r = await detect($("video"), true);
    if (r.length === 1 && Math.abs(yaw(r[0].landmarks.positions) - 0.5) < 0.1) { const m = identify(r[0].descriptor, [emp], minScore); if (m) got.push(m.dist); else if (got.length === 0 && Date.now() - t1 > 3000) return null; }
    else await sleep(80);
  }
  return got.length >= 2 ? got.reduce((a, b) => a + b, 0) / got.length : null;
}
/* Passive anti-photo check: a real face deforms a little (eyes, mouth, cheeks) even when "still";
   a photo only moves rigidly. Align every frame to the first one (rotation+scale+shift) and measure what is left. */
function flex(frames) {
  const norm = (lm) => { const p = lm.map((q) => [q.x, q.y]); const cx = p.reduce((a, q) => a + q[0], 0) / p.length, cy = p.reduce((a, q) => a + q[1], 0) / p.length; const q = p.map((a) => [a[0] - cx, a[1] - cy]); const sc = Math.sqrt(q.reduce((a, b) => a + b[0] * b[0] + b[1] * b[1], 0) / q.length) || 1; return q.map((a) => [a[0] / sc, a[1] / sc]); };
  const N = frames.map(norm), R = N[0];
  const al = N.map((P) => { let a = 0, b = 0; for (let i = 0; i < P.length; i++) { a += P[i][0] * R[i][0] + P[i][1] * R[i][1]; b += P[i][0] * R[i][1] - P[i][1] * R[i][0]; } const h = Math.hypot(a, b) || 1, c = a / h, s = b / h; return P.map((q) => [q[0] * c - q[1] * s, q[0] * s + q[1] * c]); });
  const n = R.length; let tot = 0;
  for (let i = 0; i < n; i++) { const mx = al.reduce((a, P) => a + P[i][0], 0) / al.length, my = al.reduce((a, P) => a + P[i][1], 0) / al.length; tot += al.reduce((a, P) => a + Math.hypot(P[i][0] - mx, P[i][1] - my), 0) / al.length; }
  return tot / n;
}
async function motionScore(ms = 2600) {
  const t0 = Date.now(), fr = [];
  while (Date.now() - t0 < ms) { const r = await detect($("video"), false); if (r.length === 1) fr.push(r[0].landmarks.positions.map((q) => ({ x: q.x, y: q.y }))); await sleep(40); }
  return fr.length >= 6 ? flex(fr) : null;
}
async function challenge(emp, firstDist) {
  mode = "challenge";
  const st = cache.settings, minScore = Number(st.min_match_score), required = st.liveness_required !== false;
  let score = 1 - firstDist, passive = null;
  if (required) {
    /* passive check only: no movement asked. Several strict frontal frames must all match the same person. */
    oval("ok"); setStatus("انظر للكاميرا مباشرة", `أهلاً ${emp.full_name.split(" ")[0]}`, "");
    const d = await reverify(emp, minScore, 4000);
    if (d === null) { mode = "scan"; oval(); setStatus("لم يتطابق الوجه", "حاول من جديد.", "warn"); await sleep(1500); return resumeScan(); }
    score = Math.min(score, 1 - d);
    const mv = window.__motion !== undefined ? window.__motion : await motionScore();
    passive = "passive:" + (mv === null ? "na" : mv.toFixed(4));
    if (mv !== null && mv < MOTION_MIN) { mode = "scan"; oval(); setStatus("لم يتأكد الجهاز أنك شخص حقيقي", "انظر للكاميرا بشكل طبيعي وحاول مرة أخرى.", "warn"); await sleep(2200); return resumeScan(); }
  }
  cur = { emp, score, challenge: passive, shot: SNAPSHOTS ? snapshot() : null };
  openMenu();
}
function resumeScan() { clearTimeout(scanTimer); sc.hold = 0; sc.goneAt = 0; scReset(); mode = "scan"; oval(); setStatus("قف أمام الكاميرا", "انظر للكاميرا مباشرة وسيتعرف عليك الجهاز."); scanTimer = setTimeout(scanLoop, 0); }

/* ---------- menu ---------- */
function armIdle(ms = 30000) { clearTimeout(idleTimer); idleTimer = setTimeout(goIdle, ms); }
function goIdle() { clearTimeout(idleTimer); cur = null; show("scan"); resumeScan(); }
function openMenu() {
  mode = "menu"; show("menu"); armIdle();
  const e = cur.emp, inside = !!e.open_since;
  $("hello").textContent = "أهلاً " + e.full_name.split(" ")[0];
  $("m-punch-t").textContent = inside ? "تسجيل انصراف" : "تسجيل حضور";
  $("m-punch-s").textContent = inside ? "حضرت " + new Date(e.open_since).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "ابدأ يومك";
}
/* Small JPEG of whoever is at the door, kept with the punch for the manager's review. */
function snapshot() {
  try {
    const v = $("video"); if (!v.videoWidth) return null;
    const w = 240, h = Math.round(w * v.videoHeight / v.videoWidth), c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(v, 0, 0, w, h); return c.toDataURL("image/jpeg", 0.6);
  } catch { return null; }
}
async function punch() {
  const e = cur.emp, inside = !!e.open_since, t = now();
  const last = LS.get("last_" + e.id, 0);
  if (Date.now() - last < 120000) { $("m-punch-s").textContent = "سجّلت قبل لحظات"; return; }
  const ev = { client_event_id: crypto.randomUUID(), employee_id: e.id, kind: inside ? "out" : "in", occurred_at: t.toISOString(),
    match_score: Number(cur.score.toFixed(3)), liveness_challenge: cur.challenge, liveness_passed: true, snapshot: cur.shot || null };
  const q = [...qE(), ev]; if (q.length > 30) q.forEach((x, i) => { if (i < q.length - 5) delete x.snapshot; }); /* keep offline storage small */
  LS.set("qe", q); LS.set("last_" + e.id, Date.now());
  e.open_since = inside ? null : ev.occurred_at; LS.set("cache", cache);
  netBadge(navigator.onLine); flush();
  finish(inside ? "تم تسجيل انصرافك" : "تم تسجيل حضورك", `${e.full_name} · ${t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`);
}
function finish(t, s, ms = 3200) { mode = "done"; $("done-t").textContent = t; $("done-s").textContent = s; show("done"); clearTimeout(idleTimer); setTimeout(goIdle, ms); }
$("m-punch").onclick = punch; $("m-cancel").onclick = goIdle;
document.querySelectorAll("[data-back]").forEach((b) => (b.onclick = () => { openMenu(); }));
["s-menu", "s-advance", "s-leave", "s-balance"].forEach((id) => $(id).addEventListener("pointerdown", () => { if (cur) armIdle(); }));

/* ---------- advance ---------- */
let adv = "";
function nextMonth() { const d = now(); return new Date(d.getFullYear(), d.getMonth() + 1, 1); }
function drawAdv() {
  $("adv-amt").innerHTML = `${adv ? money(adv) : "0"} <span>ج.م</span>`;
  [...$("adv-chips").children].forEach((c) => c.classList.toggle("sel", c.dataset.v === adv));
}
$("m-advance").onclick = () => {
  adv = ""; $("adv-err").textContent = ""; show("advance"); mode = "advance";
  $("adv-chips").innerHTML = [500, 1000, 1500, 2000].map((v) => `<button class="chip" data-v="${v}">${money(v)}</button>`).join("");
  [...$("adv-chips").children].forEach((c) => (c.onclick = () => { adv = c.dataset.v; drawAdv(); }));
  $("adv-keys").innerHTML = ["1","2","3","4","5","6","7","8","9","⌫","0","C"].map((k) => `<button class="key" data-k="${k}">${k}</button>`).join("");
  [...$("adv-keys").children].forEach((b) => (b.onclick = () => { const k = b.dataset.k;
    adv = k === "⌫" ? adv.slice(0, -1) : k === "C" ? "" : (adv + k).replace(/^0+/, "").slice(0, 6); drawAdv(); }));
  $("adv-when").textContent = "تُخصم من مرتب " + nextMonth().toLocaleDateString("ar-EG", { month: "long", year: "numeric" }) + " بعد موافقة الإدارة.";
  drawAdv();
};
$("adv-go").onclick = () => {
  if (!(Number(adv) > 0)) { $("adv-err").textContent = "اختر مبلغاً أولاً"; return; }
  const m = nextMonth(), rm = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}-01`;
  LS.set("qr", [...qR(), { type: "advance", client_request_id: crypto.randomUUID(), employee_id: cur.emp.id, amount: Number(adv), repay_month: rm }]);
  netBadge(navigator.onLine); flush(); finish("وصل طلب السلفة", `${money(adv)} ج.م · بانتظار موافقة الإدارة`);
};

/* ---------- leave ---------- */
function lvCalc() {
  const a = $("lv-from").value, b = $("lv-to").value;
  if (a && b && b >= a) $("lv-days").textContent = "عدد الأيام: " + (Math.round((new Date(b) - new Date(a)) / 864e5) + 1);
  else $("lv-days").textContent = "";
}
$("m-leave").onclick = () => {
  const iso = (d) => d.toISOString().slice(0, 10), t = iso(now());
  $("lv-from").min = $("lv-to").min = t; $("lv-from").value = $("lv-to").value = t; $("lv-err").textContent = ""; lvCalc(); show("leave"); mode = "leave";
};
$("lv-from").onchange = () => { if ($("lv-to").value < $("lv-from").value) $("lv-to").value = $("lv-from").value; lvCalc(); };
$("lv-to").onchange = lvCalc;
$("lv-go").onclick = () => {
  const a = $("lv-from").value, b = $("lv-to").value;
  if (!a || !b || b < a) { $("lv-err").textContent = "اختر تاريخاً صحيحاً"; return; }
  LS.set("qr", [...qR(), { type: "leave", client_request_id: crypto.randomUUID(), employee_id: cur.emp.id, from_date: a, to_date: b, kind: $("lv-kind").value }]);
  netBadge(navigator.onLine); flush(); finish("وصل طلب الإجازة", "بانتظار موافقة الإدارة");
};

/* ---------- balance ---------- */
$("m-balance").onclick = () => {
  const b = cur.emp.balance; show("balance"); mode = "balance";
  $("bal-month").textContent = "صافي مرتبك حتى اليوم · " + now().toLocaleDateString("ar-EG", { month: "long" });
  if (!b) { $("bal-net").textContent = "—"; $("bal-rows").innerHTML = ""; $("bal-note").textContent = "لا توجد بيانات بعد. حاول بعد اتصال الجهاز بالإنترنت."; return; }
  $("bal-net").innerHTML = `${money(b.net)} <span>ج.م</span>`;
  const rows = [["الأجر الأساسي", b.base, ""], ["خصم التأخير والانصراف المبكر", b.late, "-"], ["خصم الغياب", b.absence, "-"],
    ["أجر الإضافي", b.overtime, "+"], ["سلفة تُخصم هذا الشهر", b.advances, "-"], ["خصومات أخرى", b.other, "-"]].filter((r) => r[0] === "الأجر الأساسي" || Number(r[1]) !== 0);
  $("bal-rows").innerHTML = rows.map((r) => `<div class="row"><span>${r[0]}</span><b>${r[2]} ${money(Math.abs(r[1]))} ج.م</b></div>`).join("");
  $("bal-note").textContent = "آخر تحديث للأرقام: " + (cache.server_time ? new Date(cache.server_time).toLocaleString("ar-EG") : "—") + ". المرتب النهائي يعتمده المدير.";
};

/* ---------- pair device (admin signs in once) ---------- */
const rest = async (path, { method = "GET", token, body, prefer } = {}) => {
  const r = await fetch(CFG.url + path, { method, headers: { apikey: CFG.key, authorization: "Bearer " + (token || CFG.key), "content-type": "application/json", ...(prefer ? { prefer } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j; try { j = txt ? JSON.parse(txt) : null; } catch { j = txt; }
  if (!r.ok) throw new Error((j && (j.msg || j.message || j.error_description)) || "خطأ " + r.status);
  return j;
};
const login = (email, password) => rest("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((x) => x.toString(16).padStart(2, "0")).join("");
$("su-go").onclick = async () => {
  $("su-err").textContent = "";
  try {
    const a = await login($("su-email").value.trim(), $("su-pass").value);
    const p = (await rest("/rest/v1/profiles?select=company_id,role&id=eq." + a.user.id, { token: a.access_token }))[0];
    if (!p || !["owner", "accountant"].includes(p.role)) throw new Error("هذا الحساب ليس مدير شركة");
    const tok = [...crypto.getRandomValues(new Uint8Array(32))].map((x) => x.toString(16).padStart(2, "0")).join("");
    await rest("/rest/v1/devices", { method: "POST", token: a.access_token, body: { company_id: p.company_id, name: $("su-name").value || "جهاز", token_hash: await sha(tok) } });
    LS.set("token", tok); location.reload();
  } catch (e) { $("su-err").textContent = e.message; }
};

/* ---------- admin: enroll faces (hidden: press the logo for 2 seconds) ---------- */
let adm = null, pick = null, shots = [];
let pressT, taps = [];
$("logo").addEventListener("pointerdown", () => { pressT = setTimeout(openAdmin, 2000);
  const t = Date.now(); taps = taps.filter((x) => t - x < 2500); taps.push(t); if (taps.length >= 5) { taps = []; openAdmin(); } });
["pointerup", "pointerleave"].forEach((ev) => $("logo").addEventListener(ev, () => clearTimeout(pressT)));
async function openAdmin() {
  mode = "admin"; show("admin"); adm = null; $("ad-login").style.display = "flex"; $("ad-main").style.display = "none"; $("ad-err").textContent = "";
}
$("ad-exit").onclick = () => { adm = null; pick = null; shots = []; goIdle(); };
$("ad-go").onclick = async () => {
  try {
    const a = await login($("ad-email").value.trim(), $("ad-pass").value);
    const p = (await rest("/rest/v1/profiles?select=company_id,role&id=eq." + a.user.id, { token: a.access_token }))[0];
    if (!p || !["owner", "accountant"].includes(p.role)) throw new Error("هذا الحساب ليس مدير شركة");
    adm = { token: a.access_token, company: p.company_id };
    const emps = await rest("/rest/v1/employees?select=id,full_name&active=eq.true&order=full_name", { token: adm.token });
    const enrolled = new Set((cache?.employees || []).filter((e) => (e.templates || []).length).map((e) => e.id));
    $("ad-list").innerHTML = emps.map((e) => `<button class="emp" data-id="${e.id}"><span>${e.full_name}</span><span style="color:var(--mute);font-size:16px">${enrolled.has(e.id) ? "مسجّل ✓" : ""}</span></button>`).join("");
    [...$("ad-list").children].forEach((b) => (b.onclick = () => { pick = b.dataset.id; shots = []; $("ad-err2").textContent = ""; drawShots();
      [...$("ad-list").children].forEach((x) => x.classList.toggle("sel", x === b)); }));
    $("ad-login").style.display = "none"; $("ad-main").style.display = "flex"; await startCam($("video2"));
  } catch (e) { $("ad-err").textContent = e.message; }
};
/* Enrollment: 5 guided shots, each checked for quality; the shots must be the same person and must not look like someone already enrolled. */
const SHOTS = [
  { n: "مواجهة", hint: "انظر للكاميرا مباشرة", ok: (y) => y > 0.44 && y < 0.56 },
  { n: "يمين", hint: "مِل رأسك قليلاً لليمين", ok: (y) => y > 0.30 && y < 0.42 },
  { n: "يسار", hint: "مِل رأسك قليلاً لليسار", ok: (y) => y > 0.58 && y < 0.70 },
  { n: "مواجهة", hint: "انظر مباشرة مرة أخرى", ok: (y) => y > 0.44 && y < 0.56 },
  { n: "ابتسامة", hint: "انظر مباشرة وابتسم", ok: (y) => y > 0.44 && y < 0.56 },
];
const SAME_PERSON = 0.5, TOO_CLOSE_TO_OTHER = 0.5;
function drawShots() {
  $("ad-shots").innerHTML = SHOTS.map((x, i) => `<div style="flex:1;min-width:0;height:44px;border-radius:12px;border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:13px;background:${shots[i] ? "#E6F1EA" : i === shots.length ? "#F2ECE3" : "#fff"}">${x.n}${shots[i] ? " ✓" : ""}</div>`).join("");
  $("ad-save").disabled = shots.length < SHOTS.length;
  if (pick) $("ad-hint").textContent = shots.length < SHOTS.length ? `${shots.length + 1} من ${SHOTS.length}: ${SHOTS[shots.length].hint} ثم اضغط التقاط` : "جاهز للحفظ";
}
$("ad-shot").onclick = async () => {
  $("ad-err2").textContent = "";
  if (!pick) { $("ad-err2").textContent = "اختر موظفاً أولاً"; return; }
  if (shots.length >= SHOTS.length) shots = [];
  const r = await detect($("video2"), true), v = $("video2"), step = SHOTS[shots.length];
  if (r.length !== 1) { $("ad-err2").textContent = r.length ? "وجه واحد فقط أمام الكاميرا" : "لم أجد وجهاً، اقترب من الكاميرا"; return; }
  const f = r[0], lm = f.landmarks.positions, y = yaw(lm);
  if (f.detection.box.width < v.videoWidth * 0.28) { $("ad-err2").textContent = "اقترب أكثر من الكاميرا"; return; }
  if (f.detection.score < 0.6) { $("ad-err2").textContent = "الصورة غير واضحة، حسّن الإضاءة وثبّت الجهاز"; return; }
  if (eyeOpen(lm) < 0.2) { $("ad-err2").textContent = "افتح عينيك جيداً"; return; }
  if (!step.ok(y)) { $("ad-err2").textContent = "الوضعية غير صحيحة: " + step.hint; return; }
  const d = Array.from(f.descriptor);
  if (shots.length && dist(d, shots[0]) > SAME_PERSON) { shots = []; drawShots(); $("ad-err2").textContent = "اللقطة لا تشبه الأولى. ابدأ من جديد وتأكد أن الموظف نفسه أمام الكاميرا."; return; }
  const other = (cache?.employees || []).filter((e) => e.id !== pick).map((e) => ({ e, d: Math.min(9, ...(e.templates || []).map((t) => dist(d, t))) })).sort((a, b) => a.d - b.d)[0];
  if (other && other.d < TOO_CLOSE_TO_OTHER) { shots = []; drawShots(); $("ad-err2").textContent = `هذا الوجه يشبه الموظف «${other.e.full_name}» المسجّل بالفعل. تأكد أنك اخترت الموظف الصحيح.`; return; }
  shots.push(d); drawShots();
};
$("ad-save").onclick = async () => {
  $("ad-err2").textContent = "";
  try {
    if (!$("ad-consent").checked) throw new Error("لازم تؤكد وجود الموافقة المكتوبة");
    await rest("/rest/v1/biometric_consents", { method: "POST", token: adm.token, body: { company_id: adm.company, employee_id: pick, policy_version: "v1" } });
    const r = await fetch(FN, { method: "POST", headers: { "content-type": "application/json", apikey: CFG.key, authorization: "Bearer " + adm.token }, body: JSON.stringify({ action: "enroll", employee_id: pick, embeddings: shots }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || "فشل الحفظ");
    shots = []; pick = null; drawShots(); [...$("ad-list").children].forEach((x) => x.classList.remove("sel")); $("ad-consent").checked = false; $("ad-hint").textContent = "تم الحفظ ✓ اختر الموظف التالي.";
    await sync();
  } catch (e) { $("ad-err2").textContent = e.message; }
};

/* ---------- boot ---------- */
(async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (!LS.get("token", "")) { show("setup"); return; }
  try {
    $("loadmsg").textContent = "تحميل نموذج التعرف على الوجه…"; await loadModels();
    $("loadmsg").textContent = "تشغيل الكاميرا…"; await startCam($("video"));
  } catch (e) { $("loadmsg").textContent = "تعذر تشغيل الكاميرا: اسمح للمتصفح باستخدامها ثم أعد التحميل."; console.error(e); return; }
  netBadge(navigator.onLine); await sync(); tickClock(); show("scan"); resumeScan();
  setInterval(sync, 60000);
  addEventListener("online", sync); addEventListener("offline", () => netBadge(false));
})();
})();
