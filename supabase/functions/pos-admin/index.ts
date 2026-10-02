import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function staffEmail(username: string, tenantId: string | null) {
  const slug = String(username || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9._-]/g, "");
  const scope = tenantId ? String(tenantId).toLowerCase().replace(/[^a-z0-9._-]/g, "") : "mex";
  return `${slug || "user"}.${scope}@users.mexpro.app`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!url || !serviceKey) return json({ error: "Supabase env is not configured" }, 500);

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");

  async function caller() {
    const header = req.headers.get("Authorization") || "";
    const token = header.replace(/^Bearer\s+/i, "");
    if (!token || token === anonKey) return null;
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: header } },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data } = await userClient.auth.getUser();
    if (!data.user) return null;
    const { data: profile } = await admin.from("profiles").select("*").eq("id", data.user.id).maybeSingle();
    return profile;
  }

  // Owners and superadmin always manage staff. Other roles need the
  // `users_manage` permission (company override, else built-in default: admin only),
  // and may only manage lower roles (accountant / employee).
  async function staffAccess(profile: Record<string, unknown>, tenantId: string | null) {
    if (profile.role === "superadmin") return { allowed: true, manager: false };
    if (!tenantId || profile.tenant_id !== tenantId) return { allowed: false, manager: false };
    if (profile.role === "owner") return { allowed: true, manager: false };
    const row = await admin.from("role_permissions").select("permissions")
      .eq("tenant_id", tenantId).eq("role", String(profile.role)).maybeSingle();
    const override = row.data && row.data.permissions ? (row.data.permissions as Record<string, unknown>).users_manage : undefined;
    const allowed = typeof override === "boolean" ? override : profile.role === "admin";
    return { allowed, manager: allowed };
  }
  const LOWER_ROLES = ["accountant", "employee"];
  const STAFF_ROLES = ["admin", "accountant", "employee"];

  async function createLogin(opts: {
    email: string;
    password: string;
    username: string;
    fullName: string;
    phone: string;
    role: string;
    tenantId: string | null;
    store: string | null;
    appUserId: number | null;
  }) {
    const created = await admin.auth.admin.createUser({
      email: opts.email,
      password: opts.password,
      email_confirm: true,
      user_metadata: {
        username: opts.username,
        full_name: opts.fullName,
        role: opts.role,
        tenant_id: opts.tenantId,
        store: opts.store,
        phone: opts.phone,
      },
    });
    if (created.error || !created.data.user) {
      return { error: created.error?.message || "Could not create user" };
    }
    const profile = {
      id: created.data.user.id,
      username: opts.username,
      full_name: opts.fullName,
      phone: opts.phone,
      email: opts.email,
      role: opts.role,
      tenant_id: opts.tenantId,
      store: opts.store,
      app_user_id: opts.appUserId,
    };
    const saved = await admin.from("profiles").upsert(profile);
    if (saved.error) return { error: saved.error.message };
    return { authId: created.data.user.id };
  }

  async function findProfile(username: string, tenantId: string | null) {
    let query = admin.from("profiles").select("*").eq("username", username);
    query = tenantId ? query.eq("tenant_id", tenantId) : query.is("tenant_id", null);
    return await query.maybeSingle();
  }

  if (action === "bootstrap_superadmin") {
    const existing = await admin.from("profiles").select("id").eq("role", "superadmin").limit(1);
    if (existing.error) return json({ error: existing.error.message }, 400);
    if (existing.data && existing.data.length) return json({ error: "A super admin already exists." }, 403);
    const username = String(body.username || "Mex").trim();
    const password = String(body.password || "");
    const email = String(body.email || "").trim().toLowerCase();
    const fullName = String(body.fullName || "Super Admin").trim();
    if (!email || !email.includes("@")) return json({ error: "A valid email is required." }, 400);
    if (password.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);
    const made = await createLogin({
      email,
      password,
      username,
      fullName,
      phone: String(body.phone || ""),
      role: "superadmin",
      tenantId: null,
      store: "All",
      appUserId: 0,
    });
    if (made.error) return json({ error: made.error }, 400);
    return json({ ok: true, authId: made.authId, email });
  }

  if (action === "register_company") {
    const company = String(body.company || "").trim();
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const phone = String(body.phone || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const tenantId = String(body.tenantId || "").trim();
    if (!company || !username || !tenantId || password.length < 6) {
      return json({ error: "Company, username, and a password of at least 6 characters are required." }, 400);
    }
    const ownerEmail = email || staffEmail(username, tenantId);
    const owner = await createLogin({
      email: ownerEmail,
      password,
      username,
      fullName: company,
      phone,
      role: "owner",
      tenantId,
      store: company,
      appUserId: 1,
    });
    if (owner.error) return json({ error: owner.error }, 400);

    const demos = [
      { username: "admin", password: "admin123", role: "admin", fullName: "Admin User", appUserId: 2 },
      { username: "employee", password: "emp123", role: "employee", fullName: "Employee User", appUserId: 3 },
      { username: "accountant", password: "acc123", role: "accountant", fullName: "Accountant User", appUserId: 4 },
    ];
    for (const demo of demos) {
      const made = await createLogin({
        email: staffEmail(demo.username, tenantId),
        password: demo.password,
        username: demo.username,
        fullName: demo.fullName,
        phone: "",
        role: demo.role,
        tenantId,
        store: company,
        appUserId: demo.appUserId,
      });
      if (made.error) return json({ error: made.error }, 400);
    }
    return json({ ok: true, tenantId, email: ownerEmail });
  }

  const profile = await caller();
  if (!profile) return json({ error: "Sign in required." }, 401);

  if (action === "provision_company") {
    const tenantId = String(body.tenantId || profile.tenant_id || "").trim();
    const company = String(body.company || profile.store || "").trim();
    const allowed = profile.role === "superadmin" || (profile.role === "owner" && profile.tenant_id === tenantId);
    if (!allowed) return json({ error: "Only the company owner can finish setup." }, 403);
    if (!tenantId || !company) return json({ error: "Company setup is incomplete." }, 400);
    const demos = [
      { username: "admin", password: "admin123", role: "admin", fullName: "Admin User", appUserId: 2 },
      { username: "employee", password: "emp123", role: "employee", fullName: "Employee User", appUserId: 3 },
      { username: "accountant", password: "acc123", role: "accountant", fullName: "Accountant User", appUserId: 4 },
    ];
    for (const demo of demos) {
      const exists = await findProfile(demo.username, tenantId);
      if (exists.data) continue;
      const made = await createLogin({
        email: staffEmail(demo.username, tenantId),
        password: demo.password,
        username: demo.username,
        fullName: demo.fullName,
        phone: "",
        role: demo.role,
        tenantId,
        store: company,
        appUserId: demo.appUserId,
      });
      if (made.error) return json({ error: made.error }, 400);
    }
    return json({ ok: true, tenantId });
  }

  if (action === "create_staff") {
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const role = String(body.role || "employee");
    const tenantId = body.tenantId ? String(body.tenantId) : null;
    const access = await staffAccess(profile, tenantId);
    if (!access.allowed) return json({ error: "You do not have permission to add logins." }, 403);
    const roleOk = role === "mexemployee"
      ? profile.role === "superadmin"
      : (access.manager ? LOWER_ROLES.includes(role) : STAFF_ROLES.includes(role));
    if (!roleOk) return json({ error: "You cannot assign that role." }, 403);
    if (!username || password.length < 6) return json({ error: "Username and a password of at least 6 characters are required." }, 400);
    const made = await createLogin({
      email: String(body.email || "").trim().toLowerCase() || staffEmail(username, tenantId),
      password,
      username,
      fullName: String(body.fullName || username),
      phone: String(body.phone || ""),
      role: profile.role === "superadmin" && role === "mexemployee" ? "mexemployee" : role,
      tenantId: role === "mexemployee" ? null : tenantId,
      store: body.store ? String(body.store) : null,
      appUserId: body.appUserId ? Number(body.appUserId) : null,
    });
    if (made.error) return json({ error: made.error }, 400);
    return json({ ok: true, authId: made.authId });
  }

  if (action === "set_password") {
    const username = String(body.username || "").trim();
    const tenantId = body.tenantId ? String(body.tenantId) : null;
    const password = String(body.password || "");
    if (password.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);
    const access = await staffAccess(profile, tenantId);
    if (!access.allowed) return json({ error: "Not allowed." }, 403);
    const found = await findProfile(username, tenantId);
    if (found.error || !found.data) return json({ error: "User not found." }, 404);
    if (access.manager && !LOWER_ROLES.includes(String(found.data.role))) return json({ error: "Not allowed." }, 403);
    const updated = await admin.auth.admin.updateUserById(found.data.id, { password });
    if (updated.error) return json({ error: updated.error.message }, 400);
    return json({ ok: true });
  }

  if (action === "update_staff") {
    const username = String(body.username || "").trim();
    const tenantId = body.tenantId ? String(body.tenantId) : null;
    const access = await staffAccess(profile, tenantId);
    if (!access.allowed) return json({ error: "Not allowed." }, 403);
    const found = await findProfile(username, tenantId);
    if (found.error || !found.data) return json({ error: "User not found." }, 404);
    if (found.data.role === "owner" || found.data.role === "superadmin") return json({ error: "That account cannot be changed here." }, 403);
    if (access.manager && !LOWER_ROLES.includes(String(found.data.role))) return json({ error: "Not allowed." }, 403);
    if (body.role) {
      const nr = String(body.role);
      const okRole = access.manager ? LOWER_ROLES.includes(nr) : (STAFF_ROLES.includes(nr) || (profile.role === "superadmin" && nr === "mexemployee"));
      if (!okRole) return json({ error: "You cannot assign that role." }, 403);
    }
    const patch: Record<string, unknown> = {};
    if (body.role) patch.role = String(body.role);
    if (body.store !== undefined) patch.store = body.store ? String(body.store) : null;
    if (body.fullName) patch.full_name = String(body.fullName);
    if (body.phone !== undefined) patch.phone = String(body.phone || "");
    if (Object.keys(patch).length) {
      const saved = await admin.from("profiles").update(patch).eq("id", found.data.id);
      if (saved.error) return json({ error: saved.error.message }, 400);
    }
    return json({ ok: true });
  }

  if (action === "delete_staff") {
    const username = String(body.username || "").trim();
    const tenantId = body.tenantId ? String(body.tenantId) : null;
    const access = await staffAccess(profile, tenantId);
    if (!access.allowed) return json({ error: "Not allowed." }, 403);
    const found = await findProfile(username, tenantId);
    if (found.error || !found.data) return json({ error: "User not found." }, 404);
    if (access.manager && !LOWER_ROLES.includes(String(found.data.role))) return json({ error: "Not allowed." }, 403);
    if (found.data.role === "owner" || found.data.role === "superadmin") {
      return json({ error: "That account cannot be deleted here." }, 403);
    }
    const removed = await admin.auth.admin.deleteUser(found.data.id);
    if (removed.error) return json({ error: removed.error.message }, 400);
    return json({ ok: true });
  }

  return json({ error: "Unknown action." }, 400);
});
