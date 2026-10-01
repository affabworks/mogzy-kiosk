// Mogzy kiosk API. Deploy with "Verify JWT" OFF (the kiosk authenticates with its own device token).
// Face events are written ONLY here, with the service role: clients can never insert source='face'.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-device-token, content-type, apikey",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });

async function sha256(t: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

async function deviceFrom(req: Request) {
  const tok = req.headers.get("x-device-token");
  if (!tok) return null;
  const { data } = await db.from("devices").select("id, company_id, name").eq("token_hash", await sha256(tok)).eq("active", true).maybeSingle();
  if (data) await db.from("devices").update({ last_seen_at: new Date().toISOString() }).eq("id", data.id);
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  try {
    // ---------------- admin: enroll a face (needs the admin's own login)
    if (body.action === "enroll") {
      const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");
      const { data: u } = await db.auth.getUser(jwt);
      if (!u?.user) return json({ error: "unauthorized" }, 401);
      const { data: p } = await db.from("profiles").select("company_id, role, active").eq("id", u.user.id).maybeSingle();
      const { data: emp } = await db.from("employees").select("id, company_id").eq("id", body.employee_id).maybeSingle();
      const admin = p && p.active && emp && (p.role === "platform_owner" || (p.company_id === emp.company_id && ["owner", "accountant"].includes(p.role)));
      if (!admin) return json({ error: "forbidden" }, 403);
      const embs: number[][] = body.embeddings;
      if (!Array.isArray(embs) || embs.length < 1 || embs.length > 8 || embs.some((e) => !Array.isArray(e) || e.length !== 128))
        return json({ error: "bad embeddings" }, 400);
      await db.from("face_templates").delete().eq("employee_id", emp!.id);
      const { error } = await db.from("face_templates").insert(
        embs.map((e) => ({ company_id: emp!.company_id, employee_id: emp!.id, embedding: e, model: "face-api-128" })));
      if (error) return json({ error: error.message }, 400); // e.g. written consent missing
      await db.from("audit_log").insert({ company_id: emp!.company_id, actor: u.user.id, action: "face_enrolled", entity: "employees", entity_id: emp!.id });
      return json({ ok: true });
    }

    // ---------------- everything else: the kiosk itself
    const dev = await deviceFrom(req);
    if (!dev) return json({ error: "device not recognised" }, 401);

    if (body.action === "sync") {
      const cid = dev.company_id;
      const [{ data: co }, { data: st }, { data: emps }, { data: tpl }, { data: open }] = await Promise.all([
        db.from("companies").select("name, timezone").eq("id", cid).single(),
        db.from("company_settings").select("min_match_score, liveness_required, liveness_challenges").eq("company_id", cid).single(),
        db.from("employees").select("id, full_name, job_title, shift_start, shift_end").eq("company_id", cid).eq("active", true),
        db.from("face_templates").select("employee_id, embedding").eq("company_id", cid),
        db.from("attendance_sessions").select("employee_id, check_in").eq("company_id", cid).is("check_out", null),
      ]);
      const month = new Date().toISOString().slice(0, 7) + "-01";
      const list = await Promise.all((emps ?? []).map(async (e: any) => {
        const { data: pr } = await db.rpc("payroll_month", { p_employee: e.id, p_month: month });
        const r = Array.isArray(pr) ? pr[0] : pr;
        return {
          ...e,
          templates: (tpl ?? []).filter((t: any) => t.employee_id === e.id).map((t: any) => t.embedding),
          open_since: (open ?? []).find((o: any) => o.employee_id === e.id)?.check_in ?? null,
          balance: r ? {
            net: r.net_pay, base: r.base_pay, late: Number(r.late_deduction) + Number(r.early_leave_deduction),
            absence: r.absence_deduction, overtime: Number(r.overtime_pay) + Number(r.rest_day_pay),
            advances: r.advances_deducted, other: Number(r.deductions) + Number(r.penalties_applied) + Number(r.insurance) + Number(r.income_tax) - Number(r.bonuses),
          } : null,
        };
      }));
      return json({ company: co, settings: st, employees: list, server_time: new Date().toISOString(), device: dev.name });
    }

    if (body.action === "events") {
      const items: any[] = Array.isArray(body.items) ? body.items.slice(0, 200) : [];
      const { data: st } = await db.from("company_settings").select("min_match_score, liveness_required").eq("company_id", dev.company_id).single();
      const { data: emps } = await db.from("employees").select("id").eq("company_id", dev.company_id);
      const ok = new Set((emps ?? []).map((e: any) => e.id));
      const accepted: string[] = [], rejected: string[] = [];
      items.sort((a, b) => +new Date(a.occurred_at) - +new Date(b.occurred_at));
      const now = Date.now();
      for (const it of items) {
        const t = +new Date(it.occurred_at);
        const valid = isUuid(it.client_event_id) && ok.has(it.employee_id) && ["in", "out"].includes(it.kind)
          && t < now + 5 * 60e3 && t > now - 30 * 864e5
          && Number(it.match_score) >= Number(st!.min_match_score) && (it.liveness_passed === true || !st!.liveness_required);
        if (!valid) { rejected.push(it.client_event_id); continue; }
        const { error } = await db.from("attendance_events").insert({
          company_id: dev.company_id, employee_id: it.employee_id, device_id: dev.id, kind: it.kind,
          occurred_at: new Date(t).toISOString(), source: "face", match_score: it.match_score,
          liveness_challenge: it.liveness_challenge ?? null, liveness_passed: true, client_event_id: it.client_event_id,
        });
        if (!error || error.code === "23505") accepted.push(it.client_event_id); else rejected.push(it.client_event_id);
      }
      return json({ accepted, rejected });
    }

    if (body.action === "requests") {
      const items: any[] = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
      const { data: emps } = await db.from("employees").select("id").eq("company_id", dev.company_id);
      const ok = new Set((emps ?? []).map((e: any) => e.id));
      const accepted: string[] = [], rejected: string[] = [];
      for (const it of items) {
        if (!isUuid(it.client_request_id) || !ok.has(it.employee_id)) { rejected.push(it.client_request_id); continue; }
        let error;
        if (it.type === "advance" && Number(it.amount) > 0) {
          ({ error } = await db.from("advances").insert({ company_id: dev.company_id, employee_id: it.employee_id,
            amount: it.amount, repay_month: it.repay_month, client_request_id: it.client_request_id }));
        } else if (it.type === "leave" && it.from_date && it.to_date) {
          ({ error } = await db.from("leave_requests").insert({ company_id: dev.company_id, employee_id: it.employee_id,
            from_date: it.from_date, to_date: it.to_date, kind: it.kind ?? "annual", client_request_id: it.client_request_id }));
        } else { rejected.push(it.client_request_id); continue; }
        if (!error || error.code === "23505") accepted.push(it.client_request_id); else rejected.push(it.client_request_id);
      }
      return json({ accepted, rejected });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
