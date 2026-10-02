import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Flutterwave v3 hosted checkout (mobile money + card) for MeX PRO.
//
// Secrets (supabase secrets set ...):
//   FLW_SECRET_KEY    Flutterwave secret key (FLWSECK_TEST-... for testing)
//   FLW_SECRET_HASH   the "secret hash" you set in Flutterwave > Settings > Webhooks
//   APP_ORIGINS       optional, comma separated allowed return origins, e.g. https://you.github.io
//   FLW_PAYMENT_OPTIONS  optional, e.g. "card,mobilemoneytanzania" (default: all methods enabled on your account)
//
// Actions (POST JSON, signed-in user):
//   create_checkout  { kind: "subscription" | "ad_promotion", plan, adId?, returnUrl, phone? }
//   verify           { tx_ref, transaction_id }
// Webhook (Flutterwave, header `verif-hash`): charge.completed -> verified again with the API.

const FLW = "https://api.flutterwave.com/v3";
const CURRENCY = "TZS";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, verif-hash",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

// Prices live here, never in the browser.
const SUBSCRIPTION_PLANS: Record<string, { amount: number; days: number; label: string }> = {
  pro: { amount: 1000, days: 30, label: "MeX PRO - Pro plan (30 days)" },
};
const AD_PLANS: Record<string, { amount: number; hours: number; label: string }> = {
  "48hours": { amount: 4990, hours: 48, label: "Promote ad - 48 hours" },
  weekly: { amount: 9990, hours: 168, label: "Promote ad - 1 week" },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const flwKey = Deno.env.get("FLW_SECRET_KEY") ?? "";
  if (!url || !serviceKey) return json({ error: "Supabase env is not configured" }, 500);
  if (!flwKey) return json({ error: "Flutterwave is not configured (FLW_SECRET_KEY missing)." }, 500);

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  async function flwVerify(transactionId: string) {
    const res = await fetch(`${FLW}/transactions/${encodeURIComponent(transactionId)}/verify`, {
      headers: { Authorization: `Bearer ${flwKey}`, "Content-Type": "application/json" },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== "success" || !body.data) return null;
    return body.data as Record<string, unknown>;
  }

  // Confirms a payment with Flutterwave and applies its effect exactly once.
  async function settle(txRef: string, transactionId: string) {
    const { data: pay } = await admin.from("payments").select("*").eq("tx_ref", txRef).maybeSingle();
    if (!pay) return { ok: false, status: 404, error: "Unknown payment reference." };
    if (pay.status === "successful") return { ok: true, already: true, payment: pay };

    const tx = await flwVerify(transactionId);
    if (!tx) return { ok: false, status: 502, error: "Could not verify the payment with Flutterwave." };
    if (String(tx.tx_ref) !== String(pay.tx_ref)) return { ok: false, status: 400, error: "Reference mismatch." };
    if (tx.status !== "successful") {
      if (tx.status === "failed") await admin.from("payments").update({ status: "failed" }).eq("tx_ref", txRef).eq("status", "pending");
      return { ok: false, status: 402, error: `Payment ${String(tx.status)}.`, pending: tx.status === "pending" };
    }
    if (String(tx.currency) !== String(pay.currency) || Number(tx.amount) + 0.0001 < Number(pay.amount)) {
      return { ok: false, status: 400, error: "Paid amount does not match." };
    }

    // Claim it atomically so a webhook and a browser verify cannot both apply it.
    const claimed = await admin.from("payments").update({
      status: "successful",
      flw_transaction_id: String(tx.id ?? transactionId),
      payment_type: String(tx.payment_type ?? ""),
      paid_at: new Date().toISOString(),
    }).eq("tx_ref", txRef).neq("status", "successful").select("*");
    if (claimed.error) return { ok: false, status: 500, error: claimed.error.message };
    if (!claimed.data || !claimed.data.length) return { ok: true, already: true, payment: pay };
    const row = claimed.data[0];

    if (row.kind === "subscription") {
      const plan = SUBSCRIPTION_PLANS[row.plan];
      const days = plan ? plan.days : 30;
      const { data: cur } = await admin.from("subscriptions").select("*").eq("tenant_id", row.tenant_id).maybeSingle();
      const base = cur && cur.expires_at && new Date(cur.expires_at).getTime() > Date.now()
        ? new Date(cur.expires_at).getTime() : Date.now();
      const expires = new Date(base + days * 86400000).toISOString();
      const up = await admin.from("subscriptions").upsert({
        tenant_id: row.tenant_id,
        plan: "pro",
        status: "active",
        started_at: cur && cur.started_at ? cur.started_at : new Date().toISOString(),
        expires_at: expires,
        total_paid: Number(cur ? cur.total_paid : 0) + Number(row.amount),
        last_payment_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "tenant_id" });
      if (up.error) return { ok: false, status: 500, error: up.error.message };
    } else if (row.kind === "ad_promotion") {
      const plan = AD_PLANS[row.plan];
      const hours = plan ? plan.hours : 48;
      const { data: ad } = await admin.from("ads").select("promoted,promoted_until").eq("id", Number(row.ref_id)).maybeSingle();
      const base = ad && ad.promoted && ad.promoted_until && new Date(ad.promoted_until).getTime() > Date.now()
        ? new Date(ad.promoted_until).getTime() : Date.now();
      const up = await admin.from("ads").update({
        promoted: true,
        promoted_at: new Date().toISOString(),
        promoted_until: new Date(base + hours * 3600000).toISOString(),
        promotion_paid: Number(row.amount),
        promotion_plan: row.plan,
        promotion_payment_method: String(tx.payment_type ?? "flutterwave"),
        updated_at: new Date().toISOString(),
      }).eq("id", Number(row.ref_id));
      if (up.error) return { ok: false, status: 500, error: up.error.message };
    }
    return { ok: true, payment: row };
  }

  // ---- Flutterwave webhook (no user session; authenticated by the secret hash) ----
  const hook = req.headers.get("verif-hash");
  if (hook !== null) {
    const expected = Deno.env.get("FLW_SECRET_HASH") ?? "";
    if (!expected || hook !== expected) return json({ error: "Invalid signature." }, 401);
    const payload = await req.json().catch(() => ({}));
    const data = (payload && payload.data) || {};
    if (payload.event === "charge.completed" && data.id && data.tx_ref) {
      try { await settle(String(data.tx_ref), String(data.id)); } catch (e) { console.error("webhook settle failed", e); }
    }
    return json({ ok: true });
  }

  // ---- Signed-in user actions ----
  const header = req.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token || token === anonKey) return json({ error: "Sign in required." }, 401);
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: header } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: authData } = await userClient.auth.getUser();
  if (!authData.user) return json({ error: "Sign in required." }, 401);
  const { data: profile } = await admin.from("profiles").select("*").eq("id", authData.user.id).maybeSingle();
  if (!profile) return json({ error: "Profile not found." }, 403);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");

  if (action === "create_checkout") {
    const kind = String(body.kind || "");
    const planKey = String(body.plan || "");
    if (profile.role !== "owner" || !profile.tenant_id) {
      return json({ error: "Only a company owner can make payments." }, 403);
    }
    let amount = 0;
    let label = "";
    let refId: string | null = null;
    if (kind === "subscription") {
      const plan = SUBSCRIPTION_PLANS[planKey];
      if (!plan) return json({ error: "Unknown plan." }, 400);
      amount = plan.amount;
      label = plan.label;
    } else if (kind === "ad_promotion") {
      const plan = AD_PLANS[planKey];
      if (!plan) return json({ error: "Unknown promotion plan." }, 400);
      const adId = Number(body.adId);
      const { data: ad } = await admin.from("ads").select("id,tenant_id,title").eq("id", adId).maybeSingle();
      if (!ad || ad.tenant_id !== profile.tenant_id) return json({ error: "Ad not found for your company." }, 404);
      amount = plan.amount;
      label = `${plan.label}: ${String(ad.title || "").slice(0, 60)}`;
      refId = String(ad.id);
    } else {
      return json({ error: "Unknown payment kind." }, 400);
    }

    const returnUrl = String(body.returnUrl || "");
    let origin = "";
    try { origin = new URL(returnUrl).origin; } catch { return json({ error: "Invalid return URL." }, 400); }
    const allowed = (Deno.env.get("APP_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(origin)) return json({ error: "Return URL is not allowed." }, 400);

    const txRef = `mex_${kind}_${profile.tenant_id}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const ins = await admin.from("payments").insert({
      tx_ref: txRef, tenant_id: profile.tenant_id, profile_id: profile.id,
      kind, ref_id: refId, plan: planKey, amount, currency: CURRENCY, status: "pending",
    });
    if (ins.error) return json({ error: ins.error.message }, 500);

    const redirect = new URL(returnUrl);
    redirect.searchParams.set("flw", "1");
    const payload: Record<string, unknown> = {
      tx_ref: txRef,
      amount,
      currency: CURRENCY,
      redirect_url: redirect.toString(),
      customer: {
        email: profile.email || authData.user.email,
        name: profile.full_name || profile.username,
        phonenumber: String(body.phone || profile.phone || ""),
      },
      customizations: { title: "MeX PRO", description: label },
      meta: { tenant_id: profile.tenant_id, kind, plan: planKey, ref_id: refId },
    };
    const opts = Deno.env.get("FLW_PAYMENT_OPTIONS");
    if (opts) payload.payment_options = opts;

    const res = await fetch(`${FLW}/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${flwKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.status !== "success" || !out.data || !out.data.link) {
      await admin.from("payments").update({ status: "failed" }).eq("tx_ref", txRef);
      return json({ error: out.message || "Could not start the payment." }, 502);
    }
    return json({ ok: true, link: out.data.link, tx_ref: txRef, amount, currency: CURRENCY });
  }

  if (action === "verify") {
    const txRef = String(body.tx_ref || "");
    const transactionId = String(body.transaction_id || "");
    if (!txRef || !transactionId) return json({ error: "tx_ref and transaction_id are required." }, 400);
    const { data: pay } = await admin.from("payments").select("tenant_id").eq("tx_ref", txRef).maybeSingle();
    if (!pay) return json({ error: "Unknown payment reference." }, 404);
    if (profile.role !== "superadmin" && pay.tenant_id !== profile.tenant_id) return json({ error: "Not allowed." }, 403);
    const r = await settle(txRef, transactionId);
    if (!r.ok) return json({ error: r.error, pending: r.pending ?? false }, r.status ?? 400);
    return json({ ok: true, already: !!r.already, kind: r.payment.kind, plan: r.payment.plan, ref_id: r.payment.ref_id });
  }

  return json({ error: "Unknown action." }, 400);
});
