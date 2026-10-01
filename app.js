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
function identify(desc, emps, minScore) {
  let best = null, bd = 9, sd = 9;
  for (const e of emps) {
    let d = 9; for (const t of e.templates || []) d = Math.min(d, dist(desc, t));
    if (d < bd) { sd = bd; bd = d; best = e; } else if (d < sd) sd = d;
  }
  const thr = 1 - minScore;
  return best && bd <= thr && sd - bd >= 0.04 ? { emp: best, dist: bd } : null;
}
function yaw(lm) { const nose = lm[30].x, l = lm[0].x, r = lm[16].x; return (nose - l) / (r - l); }   // ~0.5 facing camera
function ear(lm, o) { const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y);
  return (d(o + 1, o + 5) + d(o + 2, o + 4)) / (2 * d(o, o + 3)); }
function eyeOpen(lm) { return (ear(lm, 36) + ear(lm, 42)) / 2; }
const money = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
if (typeof module !== "undefined") module.exports = { dist, identify, yaw, eyeOpen };
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
  if (!r.ok) throw new Error("http " + r.status);
  return r.json();
}
const qE = () => LS.get("qe", []), qR = () => LS.get("qr", []);
function netBadge(online) {
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
  await faceapi.nets.tinyFaceDetector.loadFromUri("models");
  await faceapi.nets.faceLandmark68Net.loadFromUri("models");
  await faceapi.nets.faceRecognitionNet.loadFromUri("models");
}
const detect = (el, withDesc) => { const t = faceapi.detectAllFaces(el, opts()).withFaceLandmarks(); return withDesc ? t.withFaceDescriptors() : t; };

/* ---------- scan loop ---------- */
const setStatus = (t, h, cls = "") => { $("status").textContent = t; $("status").className = "status " + cls; if (h !== undefined) $("hint").textContent = h; };
const oval = (c) => { $("oval").className = "oval " + (c || ""); };
function tickClock() {
  const d = now(); $("clock").textContent = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  $("date").textContent = d.toLocaleDateString("ar-EG", { weekday: "long", day: "numeric", month: "long" });
}
setInterval(tickClock, 1000);

let scanTimer = null;
async function scanLoop() {
  if (mode !== "scan" || busy) return;
  busy = true;
  try {
    const v = $("video"); const res = await detect(v, false);
    if (!cache || !cache.employees.some((e) => (e.templates || []).length)) { setStatus("لا توجد وجوه مسجلة بعد", "اطلب من المدير تسجيل الوجوه."); oval(); }
    else if (res.length === 0) { setStatus("قف أمام الكاميرا", "انظر للكاميرا مباشرة وسيتعرف عليك الجهاز."); oval(); scanLoop.n = 0; }
    else if (res.length > 1) { setStatus("وجه واحد فقط من فضلك", "ليقف شخص واحد أمام الجهاز."); oval(); scanLoop.n = 0; }
    else if (res[0].detection.box.width < v.videoWidth * 0.2) { setStatus("اقترب قليلاً", ""); oval(); scanLoop.n = 0; }
    else {
      oval("ok"); setStatus("لحظة…", "");
      scanLoop.n = (scanLoop.n || 0) + 1;
      if (scanLoop.n >= 2) {
        const full = await detect(v, true);
        if (full.length === 1) {
          const m = identify(full[0].descriptor, cache.employees, Number(cache.settings.min_match_score));
          if (m) { scanLoop.n = 0; await challenge(m.emp, m.dist); busy = false; scanTimer = setTimeout(scanLoop, 220); return; }
          scanLoop.miss = (scanLoop.miss || 0) + 1;
          if (scanLoop.miss >= 3) setStatus("لم أتعرف عليك", "حاول مرة أخرى بإضاءة أفضل، أو اطلب من المدير تسجيل وجهك.");
        }
      }
    }
  } catch (e) { console.warn(e); }
  busy = false;
  scanTimer = setTimeout(scanLoop, 220);
}

/* ---------- liveness: random head turn / blink, then re-verify the same person ---------- */
const CH = {
  turn_right: { text: "حرّك رأسك ببطء لليمين", test: (lm) => yaw(lm) < 0.38 },
  turn_left:  { text: "حرّك رأسك ببطء لليسار", test: (lm) => yaw(lm) > 0.62 },
  blink:      { text: "أغمض عينيك ثم افتحهما", test: null },
};
async function challenge(emp, firstDist) {
  mode = "challenge";
  const st = cache.settings, allowed = (st.liveness_challenges || []).filter((c) => CH[c]);
  const required = st.liveness_required !== false;
  let chName = null, score = 1 - firstDist;
  if (required) {
    const pool = allowed.length ? allowed : ["turn_right", "turn_left"];
    chName = pool[Math.floor(Math.random() * pool.length)];
    oval("go"); setStatus(CH[chName].text, "أهلاً " + emp.full_name.split(" ")[0], "chal");
    const t0 = Date.now(); let neutral = false, open = false, hits = 0, passed = false;
    while (Date.now() - t0 < 9000) {
      const r = await detect($("video"), false);
      if (r.length !== 1) { await sleep(80); continue; }
      const lm = r[0].landmarks.positions, y = yaw(lm); 
      if (chName === "blink") { const e = eyeOpen(lm); if (e > 0.26) open = true; if (open && e < 0.19) { passed = true; break; } }
      else { if (y > 0.44 && y < 0.56) neutral = true; if (neutral && CH[chName].test(lm)) { if (++hits >= 2) { passed = true; break; } } else hits = 0; }
      await sleep(60);
    }
    if (!passed) { mode = "scan"; oval(); setStatus("لم يكتمل التحقق", "حاول من جديد ببطء."); await sleep(1800); return resumeScan(); }
    // same person must still be in front of the camera after the move
    setStatus("انظر للكاميرا مباشرة", ""); let ok = false; const t1 = Date.now();
    while (Date.now() - t1 < 5000 && !ok) {
      const r = await detect($("video"), true);
      if (r.length === 1 && Math.abs(yaw(r[0].landmarks.positions) - 0.5) < 0.09) {
        const m = identify(r[0].descriptor, [emp], Number(st.min_match_score));
        if (m) { ok = true; score = 1 - m.dist; }
      } else await sleep(80);
    }
    if (!ok) { mode = "scan"; oval(); setStatus("لم يتطابق الوجه", "حاول من جديد."); await sleep(1800); return resumeScan(); }
  }
  cur = { emp, score, challenge: chName };
  openMenu();
}
function resumeScan() { clearTimeout(scanTimer); mode = "scan"; oval(); setStatus("قف أمام الكاميرا", "انظر للكاميرا مباشرة وسيتعرف عليك الجهاز."); scanTimer = setTimeout(scanLoop, 0); }

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
async function punch() {
  const e = cur.emp, inside = !!e.open_since, t = now();
  const last = LS.get("last_" + e.id, 0);
  if (Date.now() - last < 120000) { $("m-punch-s").textContent = "سجّلت قبل لحظات"; return; }
  const ev = { client_event_id: crypto.randomUUID(), employee_id: e.id, kind: inside ? "out" : "in", occurred_at: t.toISOString(),
    match_score: Number(cur.score.toFixed(3)), liveness_challenge: cur.challenge, liveness_passed: true };
  LS.set("qe", [...qE(), ev]); LS.set("last_" + e.id, Date.now());
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
  $("adv-amt").innerHTML = `${adv ? money(adv) : "0"} <span style="font-size:28px">ج.م</span>`;
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
  $("bal-net").innerHTML = `${money(b.net)} <span style="font-size:26px">ج.م</span>`;
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
let pressT; $("logo").addEventListener("pointerdown", () => { pressT = setTimeout(openAdmin, 2000); });
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
    [...$("ad-list").children].forEach((b) => (b.onclick = () => { pick = b.dataset.id; shots = []; drawShots();
      [...$("ad-list").children].forEach((x) => x.classList.toggle("sel", x === b)); }));
    $("ad-login").style.display = "none"; $("ad-main").style.display = "flex"; await startCam($("video2"));
  } catch (e) { $("ad-err").textContent = e.message; }
};
function drawShots() {
  $("ad-shots").innerHTML = [0, 1, 2].map((i) => `<div style="flex:1;height:48px;border-radius:12px;border:1.5px solid var(--line);display:flex;align-items:center;justify-content:center;background:${shots[i] ? "#E3F0E7" : "#fff"}">${["مواجهة", "يمين", "يسار"][i]} ${shots[i] ? "✓" : ""}</div>`).join("");
  $("ad-save").disabled = shots.length < 3;
}
$("ad-shot").onclick = async () => {
  $("ad-err2").textContent = "";
  if (!pick) { $("ad-err2").textContent = "اختر موظفاً أولاً"; return; }
  const r = await detect($("video2"), true);
  if (r.length !== 1) { $("ad-err2").textContent = r.length ? "وجه واحد فقط" : "لم أجد وجهاً، اقترب"; return; }
  if (shots.length >= 3) shots = [];
  shots.push(Array.from(r[0].descriptor)); drawShots();
  $("ad-hint").textContent = ["الآن مِل رأسك قليلاً لليمين ثم التقط", "الآن مِل رأسك قليلاً لليسار ثم التقط", "جاهز للحفظ"][shots.length - 1];
};
$("ad-save").onclick = async () => {
  $("ad-err2").textContent = "";
  try {
    if (!$("ad-consent").checked) throw new Error("لازم تؤكد وجود الموافقة المكتوبة");
    await rest("/rest/v1/biometric_consents", { method: "POST", token: adm.token, body: { company_id: adm.company, employee_id: pick, policy_version: "v1" } });
    const r = await fetch(FN, { method: "POST", headers: { "content-type": "application/json", apikey: CFG.key, authorization: "Bearer " + adm.token }, body: JSON.stringify({ action: "enroll", employee_id: pick, embeddings: shots }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error || "فشل الحفظ");
    shots = []; drawShots(); $("ad-consent").checked = false; $("ad-hint").textContent = "تم الحفظ ✓ اختر الموظف التالي.";
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
