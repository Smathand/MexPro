/* MeX PRO Supabase bridge.
   The POS reads and writes synchronously. This module mirrors those writes to Supabase
   and restores them on the next signed-in session. */
(function () {
    const cfg = window.MEX_SUPABASE || {};
    const url = String(cfg.url || "").trim();
    const anonKey = String(cfg.anonKey || "").trim();
    const enabled = !!(url && anonKey && window.supabase && window.supabase.createClient);

    const api = {
        enabled: enabled,
        hasSession: false,
        recovery: false,
        client: null,
        user: null,
        profile: null
    };

    if (!enabled) {
        window.MexSupabase = api;
        return;
    }

    const db = window.supabase.createClient(url, anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    api.client = db;

    const pending = new Map();
    let flushTimer = null;
    let syncHandler = null;
    let channel = null;

    function redirectTo() {
        const fromCfg = String(cfg.redirectTo || "").trim();
        if (fromCfg) return fromCfg;
        return location.origin + location.pathname;
    }

    function staffEmail(username, tenantId) {
        const slug = String(username || "").trim().toLowerCase().replace(/\s+/g, ".").replace(/[^a-z0-9._-]/g, "");
        const scope = tenantId ? String(tenantId).toLowerCase().replace(/[^a-z0-9._-]/g, "") : "mex";
        return (slug || "user") + "." + scope + "@users.mexpro.app";
    }

    function functionUnavailable(message) {
        const m = String(message || "").toLowerCase();
        return m.indexOf("failed to send") !== -1
            || m.indexOf("not found") !== -1
            || m.indexOf("failed to fetch") !== -1
            || m.indexOf("404") !== -1;
    }

    function invokeMessage(error) {
        const raw = (error && error.message) || "Request failed";
        if (functionUnavailable(raw)) {
            return "The pos-admin Edge Function is not deployed. Company signup will continue without it. Deploy it from Supabase → Edge Functions so staff logins and password resets work.";
        }
        return raw;
    }

    async function ensureProfile(fields) {
        if (!api.user) return { ok: false, message: "Not signed in" };
        const row = Object.assign({ id: api.user.id }, fields);
        const upsert = await db.from("profiles").upsert(row);
        if (!upsert.error) return { ok: true };
        const upd = await db.from("profiles").update(fields).eq("id", api.user.id);
        if (upd.error) {
            return { ok: false, message: (upd.error.message || upsert.error.message) + " — run supabase/migrations/20260924000000_init.sql in the SQL editor." };
        }
        return { ok: true };
    }

    function stripSecrets(value) {
        if (Array.isArray(value)) return value.map(stripSecrets);
        if (!value || typeof value !== "object") return value;
        const out = {};
        Object.keys(value).forEach(function (k) {
            if (k === "password") return;
            out[k] = stripSecrets(value[k]);
        });
        return out;
    }

    api.stripSecrets = stripSecrets;
    api.redirectTo = redirectTo;

    api.queue = function (scope, docKey, data) {
        if (!api.enabled) return;
        pending.set(scope + "\0" + docKey, {
            scope: scope,
            doc_key: docKey,
            data: data == null ? null : stripSecrets(data)
        });
        clearTimeout(flushTimer);
        flushTimer = setTimeout(function () { api.flush(); }, 400);
    };

    api.flush = async function () {
        if (!pending.size) return { ok: true };
        const rows = [];
        const deletes = [];
        pending.forEach(function (row) {
            if (row.data == null) deletes.push(row);
            else rows.push({ scope: row.scope, doc_key: row.doc_key, data: row.data, updated_at: new Date().toISOString() });
        });
        pending.clear();
        if (rows.length) {
            const res = await db.from("documents").upsert(rows, { onConflict: "scope,doc_key" });
            if (res.error) {
                console.error("Supabase sync failed", res.error);
                rows.forEach(function (row) { pending.set(row.scope + "\0" + row.doc_key, row); });
                return { ok: false, message: res.error.message };
            }
        }
        for (let i = 0; i < deletes.length; i++) {
            await db.from("documents").delete().eq("scope", deletes[i].scope).eq("doc_key", deletes[i].doc_key);
        }
        return { ok: true };
    };

    function writeLocal(scope, docKey, data) {
        const json = JSON.stringify(data);
        if (scope === "global" && docKey === "tenants") localStorage.setItem("sb_tenants", json);
        else if (scope === "global" && docKey === "ads") localStorage.setItem("sb_global_ads", json);
        else if (scope === "global" && docKey === "mex_employees") localStorage.setItem("sb_mex_employees", json);
        else if (scope !== "global") localStorage.setItem("sb_tenant_" + scope + "_" + docKey, json);
    }

    api.tables = { ads: false, statuses: false, roles: false, attendance: false };

    function applyRow(row, emit) {
        if (!row) return;
        if (api.tables.ads && row.scope === "global" && row.doc_key === "ads") return;
        if (api.tables.statuses && row.doc_key === "statuses") return;
        if (api.tables.roles && row.doc_key === "role_permissions") return;
        if (api.tables.attendance && (row.doc_key === "sessions" || row.doc_key === "punchHistory")) return;
        writeLocal(row.scope, row.doc_key, row.data);
        if (emit && typeof syncHandler === "function") syncHandler(row);
    }

    function mapProductRow(row) {
        return {
            id: Number(row.id),
            name: row.name,
            description: row.description || "",
            price: Number(row.price) || 0,
            cost: Number(row.cost) || 0,
            quantity: Number(row.quantity) || 0,
            category: row.category || "General",
            store: row.store || "",
            image: row.image_url || ""
        };
    }

    api.pullInventory = async function (tenantId) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        let cats = await db.from("categories").select("id,name,store").eq("tenant_id", tid);
        if (cats.error && /store|column|schema cache/i.test(cats.error.message || "")) {
            cats = await db.from("categories").select("id,name").eq("tenant_id", tid);
        }
        const prods = await db.from("products").select("*").eq("tenant_id", tid);
        if (cats.error && /does not exist|schema cache/i.test(cats.error.message || "")) return { ok: true, missing: true };
        if (cats.error) return { ok: false, message: cats.error.message };
        if (prods.error) return { ok: false, message: prods.error.message };
        if ((cats.data || []).length) {
            writeLocal(tid, "categories", (cats.data || []).map(function (c) {
                return { id: Number(c.id), name: c.name, store: c.store || "" };
            }));
        } else {
            try {
                const raw = localStorage.getItem("sb_tenant_" + tid + "_categories");
                const local = raw ? JSON.parse(raw) : [];
                if (Array.isArray(local) && local.length) await api.saveCategories(tid, local);
            } catch (e) {}
        }
        if ((prods.data || []).length) {
            writeLocal(tid, "products", (prods.data || []).map(mapProductRow));
        } else {
            try {
                const raw = localStorage.getItem("sb_tenant_" + tid + "_products");
                const local = raw ? JSON.parse(raw) : [];
                if (Array.isArray(local) && local.length) await api.saveProducts(tid, local);
            } catch (e) {}
        }
        return { ok: true };
    };

    api.saveCategories = async function (tenantId, categories) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        const rows = (categories || []).map(function (c) {
            return { tenant_id: tid, id: Number(c.id), name: String(c.name || "").trim(), store: c.store || "" };
        }).filter(function (c) { return c.id && c.name; });
        const existing = await db.from("categories").select("id").eq("tenant_id", tid);
        if (existing.error) return { ok: false, message: existing.error.message, missing: /does not exist|schema cache/i.test(existing.error.message || "") };
        const keep = {};
        rows.forEach(function (r) { keep[r.id] = true; });
        const gone = (existing.data || []).filter(function (r) { return !keep[r.id]; }).map(function (r) { return r.id; });
        if (rows.length) {
            let up = await db.from("categories").upsert(rows, { onConflict: "tenant_id,id" });
            if (up.error && /store|column|schema cache/i.test(up.error.message || "")) {
                const plain = rows.map(function (r) { return { tenant_id: r.tenant_id, id: r.id, name: r.name }; });
                up = await db.from("categories").upsert(plain, { onConflict: "tenant_id,id" });
            }
            if (up.error) return { ok: false, message: up.error.message };
        }
        if (gone.length) await db.from("categories").delete().eq("tenant_id", tid).in("id", gone);
        writeLocal(tid, "categories", categories || []);
        return { ok: true };
    };

    api.saveProducts = async function (tenantId, products) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        const rows = (products || []).map(function (p) {
            return {
                tenant_id: tid,
                id: Number(p.id),
                name: String(p.name || "").trim(),
                description: String(p.description || ""),
                price: Number(p.price) || 0,
                cost: Number(p.cost) || 0,
                quantity: Number(p.quantity) || 0,
                category: String(p.category || "General"),
                store: p.store || null,
                image_url: p.image || p.image_url || "",
                updated_at: new Date().toISOString()
            };
        }).filter(function (p) { return p.id && p.name; });
        const existing = await db.from("products").select("id").eq("tenant_id", tid);
        if (existing.error) return { ok: false, message: existing.error.message, missing: /does not exist|schema cache/i.test(existing.error.message || "") };
        const keep = {};
        rows.forEach(function (r) { keep[r.id] = true; });
        const gone = (existing.data || []).filter(function (r) { return !keep[r.id]; }).map(function (r) { return r.id; });
        if (rows.length) {
            const up = await db.from("products").upsert(rows, { onConflict: "tenant_id,id" });
            if (up.error) return { ok: false, message: up.error.message };
        }
        if (gone.length) await db.from("products").delete().eq("tenant_id", tid).in("id", gone);
        writeLocal(tid, "products", products || []);
        return { ok: true };
    };

    function mapExpenseRow(row) {
        return {
            id: Number(row.id),
            description: row.description || "",
            amount: Number(row.amount) || 0,
            category: row.category || "Other",
            store: row.store || "",
            createdBy: row.created_by || "",
            date: row.spent_at ? new Date(row.spent_at).getTime() : Date.now(),
            receipt: row.receipt_url || ""
        };
    }

    api.saveExpenseCategories = async function (tenantId, categories) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        const rows = (categories || []).map(function (c) {
            return { tenant_id: tid, id: Number(c.id), name: String(c.name || "").trim(), store: c.store || "" };
        }).filter(function (c) { return c.id && c.name; });
        const existing = await db.from("expense_categories").select("id").eq("tenant_id", tid);
        if (existing.error) return { ok: false, message: existing.error.message, missing: /does not exist|schema cache/i.test(existing.error.message || "") };
        const keep = {};
        rows.forEach(function (r) { keep[r.id] = true; });
        const gone = (existing.data || []).filter(function (r) { return !keep[r.id]; }).map(function (r) { return r.id; });
        if (rows.length) {
            let up = await db.from("expense_categories").upsert(rows, { onConflict: "tenant_id,id" });
            if (up.error && /store|column|schema cache/i.test(up.error.message || "")) {
                const plain = rows.map(function (r) { return { tenant_id: r.tenant_id, id: r.id, name: r.name }; });
                up = await db.from("expense_categories").upsert(plain, { onConflict: "tenant_id,id" });
            }
            if (up.error) return { ok: false, message: up.error.message };
        }
        if (gone.length) await db.from("expense_categories").delete().eq("tenant_id", tid).in("id", gone);
        writeLocal(tid, "expense_categories", categories || []);
        return { ok: true };
    };

    api.saveExpenses = async function (tenantId, expenses) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        const rows = (expenses || []).map(function (e) {
            return {
                tenant_id: tid,
                id: Number(e.id),
                description: String(e.description || "").trim(),
                amount: Number(e.amount) || 0,
                category: String(e.category || "Other"),
                store: e.store || null,
                created_by: e.createdBy != null ? String(e.createdBy) : null,
                spent_at: new Date(e.date || Date.now()).toISOString(),
                receipt_url: e.receipt || e.receipt_url || "",
                updated_at: new Date().toISOString()
            };
        }).filter(function (e) { return e.id && e.description; });
        const existing = await db.from("expenses").select("id").eq("tenant_id", tid);
        if (existing.error) return { ok: false, message: existing.error.message, missing: /does not exist|schema cache/i.test(existing.error.message || "") };
        const keep = {};
        rows.forEach(function (r) { keep[r.id] = true; });
        const gone = (existing.data || []).filter(function (r) { return !keep[r.id]; }).map(function (r) { return r.id; });
        if (rows.length) {
            const up = await db.from("expenses").upsert(rows, { onConflict: "tenant_id,id" });
            if (up.error) return { ok: false, message: up.error.message };
        }
        if (gone.length) await db.from("expenses").delete().eq("tenant_id", tid).in("id", gone);
        writeLocal(tid, "expenses", expenses || []);
        return { ok: true };
    };

    api.pullExpenses = async function (tenantId) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        let cats = await db.from("expense_categories").select("id,name,store").eq("tenant_id", tid);
        if (cats.error && /store|column|schema cache/i.test(cats.error.message || "")) {
            cats = await db.from("expense_categories").select("id,name").eq("tenant_id", tid);
        }
        const rows = await db.from("expenses").select("*").eq("tenant_id", tid);
        if (cats.error && /does not exist|schema cache/i.test(cats.error.message || "")) return { ok: true, missing: true };
        if (cats.error) return { ok: false, message: cats.error.message };
        if (rows.error) return { ok: false, message: rows.error.message };
        if ((cats.data || []).length) {
            writeLocal(tid, "expense_categories", (cats.data || []).map(function (c) {
                return { id: Number(c.id), name: c.name, store: c.store || "" };
            }));
        } else {
            try {
                const raw = localStorage.getItem("sb_tenant_" + tid + "_expense_categories");
                const local = raw ? JSON.parse(raw) : [];
                if (Array.isArray(local) && local.length) await api.saveExpenseCategories(tid, local);
            } catch (e) {}
        }
        if ((rows.data || []).length) {
            writeLocal(tid, "expenses", (rows.data || []).map(mapExpenseRow));
        } else {
            try {
                const raw = localStorage.getItem("sb_tenant_" + tid + "_expenses");
                const local = raw ? JSON.parse(raw) : [];
                if (Array.isArray(local) && local.length) await api.saveExpenses(tid, local);
            } catch (e) {}
        }
        return { ok: true };
    };

    function mapBranchRow(row) {
        return {
            id: Number(row.id),
            name: row.name || "",
            address: row.address || "",
            tin: row.tin || "",
            isMain: !!row.is_main,
            subscription: row.subscription || { active: false, expiry: 0, paidAmount: 0, paymentDate: null },
            permissions: row.permissions || { seeNetProfit: true, seeExpenses: true }
        };
    }

    function applyBranchesToTenants(tid, branches) {
        try {
            const raw = localStorage.getItem("sb_tenants");
            const ts = raw ? JSON.parse(raw) : [];
            const t0 = ts.find(function (x) { return String(x.id) === String(tid); });
            if (!t0) return;
            t0.branches = branches;
            localStorage.setItem("sb_tenants", JSON.stringify(ts));
        } catch (e) {}
    }

    api.saveBranches = async function (tenantId, branches) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        const rows = (branches || []).map(function (b, i) {
            return {
                tenant_id: tid,
                id: Number(b.id) || (i + 1),
                name: String(b.name || "").trim(),
                address: b.address || "",
                tin: b.tin || "",
                is_main: !!(b.isMain || b.is_main),
                subscription: b.subscription || {},
                permissions: b.permissions || {},
                updated_at: new Date().toISOString()
            };
        }).filter(function (b) { return b.id && b.name; });
        const existing = await db.from("branches").select("id").eq("tenant_id", tid);
        if (existing.error) return { ok: false, message: existing.error.message, missing: /does not exist|schema cache/i.test(existing.error.message || "") };
        const keep = {};
        rows.forEach(function (r) { keep[r.id] = true; });
        const gone = (existing.data || []).filter(function (r) { return !keep[r.id]; }).map(function (r) { return r.id; });
        if (rows.length) {
            const up = await db.from("branches").upsert(rows, { onConflict: "tenant_id,id" });
            if (up.error) return { ok: false, message: up.error.message };
        }
        if (gone.length) await db.from("branches").delete().eq("tenant_id", tid).in("id", gone);
        writeLocal(tid, "branches", branches || []);
        applyBranchesToTenants(tid, branches || []);
        return { ok: true };
    };

    api.pullBranches = async function (tenantId) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        const rows = await db.from("branches").select("*").eq("tenant_id", tid);
        if (rows.error && /does not exist|schema cache/i.test(rows.error.message || "")) return { ok: true, missing: true };
        if (rows.error) return { ok: false, message: rows.error.message };
        if ((rows.data || []).length) {
            const mapped = (rows.data || []).map(mapBranchRow);
            writeLocal(tid, "branches", mapped);
            applyBranchesToTenants(tid, mapped);
        } else {
            try {
                const rawT = localStorage.getItem("sb_tenants");
                const ts = rawT ? JSON.parse(rawT) : [];
                const t0 = ts.find(function (x) { return String(x.id) === tid; });
                const local = (t0 && Array.isArray(t0.branches)) ? t0.branches : [];
                if (local.length) await api.saveBranches(tid, local);
            } catch (e) {}
        }
        return { ok: true };
    };

    function mapSaleRow(row) {
        return {
            id: Number(row.id),
            productId: Number(row.product_id) || 0,
            quantity: Number(row.quantity) || 0,
            unitPrice: Number(row.unit_price) || 0,
            origUnitPrice: Number(row.orig_unit_price) || 0,
            originalPrice: Number(row.orig_unit_price) || Number(row.unit_price) || 0,
            discount: Number(row.discount) || 0,
            totalPrice: Number(row.total_price) || 0,
            totalCost: Number(row.total_cost) || 0,
            customer: row.customer || "",
            store: row.store || "",
            createdBy: row.created_by || "",
            date: row.sold_at ? new Date(row.sold_at).getTime() : Date.now()
        };
    }

    api.saveSales = async function (tenantId, sales) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        const rows = (sales || []).map(function (s) {
            return {
                tenant_id: tid,
                id: Number(s.id),
                product_id: s.productId != null ? Number(s.productId) : null,
                quantity: Number(s.quantity) || 0,
                unit_price: Number(s.unitPrice) || 0,
                orig_unit_price: Number(s.origUnitPrice != null ? s.origUnitPrice : s.originalPrice) || 0,
                discount: Number(s.discount) || 0,
                total_price: Number(s.totalPrice) || 0,
                total_cost: Number(s.totalCost) || 0,
                customer: s.customer || "",
                store: s.store || null,
                created_by: s.createdBy != null ? String(s.createdBy) : null,
                sold_at: new Date(s.date || Date.now()).toISOString(),
                updated_at: new Date().toISOString()
            };
        }).filter(function (s) { return s.id; });
        const existing = await db.from("sales").select("id").eq("tenant_id", tid);
        if (existing.error) return { ok: false, message: existing.error.message, missing: /does not exist|schema cache/i.test(existing.error.message || "") };
        const keep = {};
        rows.forEach(function (r) { keep[r.id] = true; });
        const gone = (existing.data || []).filter(function (r) { return !keep[r.id]; }).map(function (r) { return r.id; });
        if (rows.length) {
            const up = await db.from("sales").upsert(rows, { onConflict: "tenant_id,id" });
            if (up.error) return { ok: false, message: up.error.message };
        }
        if (gone.length) await db.from("sales").delete().eq("tenant_id", tid).in("id", gone);
        writeLocal(tid, "sales", sales || []);
        return { ok: true };
    };

    api.pullSales = async function (tenantId) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        const rows = await db.from("sales").select("*").eq("tenant_id", tid);
        if (rows.error && /does not exist|schema cache/i.test(rows.error.message || "")) return { ok: true, missing: true };
        if (rows.error) return { ok: false, message: rows.error.message };
        if ((rows.data || []).length) {
            writeLocal(tid, "sales", (rows.data || []).map(mapSaleRow));
        } else {
            try {
                const raw = localStorage.getItem("sb_tenant_" + tid + "_sales");
                const local = raw ? JSON.parse(raw) : [];
                if (Array.isArray(local) && local.length) await api.saveSales(tid, local);
            } catch (e) {}
        }
        return { ok: true };
    };


    /* ---------- Ads (global feed) ---------- */
    function isMissingTable(err) { return /does not exist|schema cache/i.test((err && err.message) || ""); }
    function toIso(ms) { return ms ? new Date(Number(ms)).toISOString() : null; }
    function toMs(iso) { return iso ? new Date(iso).getTime() : null; }

    function mapAdRow(row) {
        return {
            id: Number(row.id),
            title: row.title || "",
            content: row.content || "",
            postedBy: row.posted_by || "company",
            tenantId: row.tenant_id || null,
            authorUserId: row.author_user_id == null ? null : Number(row.author_user_id),
            authorName: row.author_name || "",
            companyName: row.company_name || "",
            timestamp: toMs(row.posted_at) || Date.now(),
            isPaid: !!row.is_paid,
            viewers: Array.isArray(row.viewers) ? row.viewers : [],
            comments: Array.isArray(row.comments) ? row.comments : [],
            mediaType: row.media_type || "none",
            mediaUrl: row.media_url || "",
            promoted: !!row.promoted,
            promotedAt: toMs(row.promoted_at),
            promotedUntil: toMs(row.promoted_until),
            promotionPaid: Number(row.promotion_paid) || 0,
            promotionPlan: row.promotion_plan || "",
            promotionPaymentMethod: row.promotion_payment_method || ""
        };
    }

    function adToRow(ad) {
        return {
            id: Number(ad.id),
            tenant_id: ad.tenantId || null,
            posted_by: ad.postedBy || "company",
            author_user_id: ad.authorUserId == null ? null : Number(ad.authorUserId),
            author_name: ad.authorName || "",
            company_name: ad.companyName || "",
            title: ad.title || "",
            content: ad.content || "",
            media_type: ad.mediaType || "none",
            media_url: ad.mediaUrl || null,
            is_paid: !!ad.isPaid,
            viewers: ad.viewers || [],
            comments: ad.comments || [],
            promoted: !!ad.promoted,
            promoted_at: toIso(ad.promotedAt),
            promoted_until: toIso(ad.promotedUntil),
            promotion_paid: Number(ad.promotionPaid) || 0,
            promotion_plan: ad.promotionPlan || null,
            promotion_payment_method: ad.promotionPaymentMethod || null,
            posted_at: toIso(ad.timestamp || Date.now()),
            updated_at: new Date().toISOString()
        };
    }

    api.saveAds = async function (ads) {
        const rows = (ads || []).map(adToRow).filter(function (r) { return r.id; });
        const existing = await db.from("ads").select("id");
        if (existing.error) return { ok: false, message: existing.error.message, missing: isMissingTable(existing.error) };
        const keep = {};
        rows.forEach(function (r) { keep[r.id] = true; });
        const gone = (existing.data || []).filter(function (r) { return !keep[r.id]; }).map(function (r) { return r.id; });
        if (rows.length) {
            const up = await db.from("ads").upsert(rows, { onConflict: "id" });
            if (up.error) return { ok: false, message: up.error.message };
        }
        if (gone.length) await db.from("ads").delete().in("id", gone);
        return { ok: true };
    };

    api.pullAds = async function () {
        const res = await db.from("ads").select("*");
        if (res.error && isMissingTable(res.error)) return { ok: true, missing: true };
        if (res.error) return { ok: false, message: res.error.message };
        api.tables.ads = true;
        if ((res.data || []).length) {
            writeLocal("global", "ads", (res.data || []).map(mapAdRow));
        } else {
            try {
                const raw = localStorage.getItem("sb_global_ads");
                const local = raw ? JSON.parse(raw) : [];
                if (Array.isArray(local) && local.length) await api.saveAds(local);
            } catch (e) {}
        }
        return { ok: true };
    };

    /* ---------- Statuses (per company) ---------- */
    function mapStatusRow(row) {
        return {
            id: Number(row.id),
            userId: row.user_id == null ? null : Number(row.user_id),
            text: row.text || "",
            image: row.image_url || null,
            timestamp: toMs(row.posted_at) || Date.now(),
            likes: Array.isArray(row.likes) ? row.likes : [],
            comments: Array.isArray(row.comments) ? row.comments : [],
            viewers: Array.isArray(row.viewers) ? row.viewers : []
        };
    }

    api.saveStatuses = async function (tenantId, statuses) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        const list = (statuses || []).slice();
        for (let i = 0; i < list.length; i++) {
            const st = list[i];
            if (st && st.image && String(st.image).indexOf("data:image") === 0) {
                try {
                    const blob = await (await fetch(st.image)).blob();
                    const up = await api.upload("statuses/" + tid + "/" + st.id, blob, blob.type);
                    if (up.ok) list[i] = Object.assign({}, st, { image: up.url });
                } catch (e) { console.warn("status image upload failed", e); }
            }
        }
        const rows = list.map(function (st) {
            return {
                tenant_id: tid,
                id: Number(st.id),
                user_id: st.userId == null ? null : Number(st.userId),
                text: st.text || "",
                image_url: (st.image && String(st.image).indexOf("data:") !== 0) ? st.image : null,
                likes: st.likes || [],
                comments: st.comments || [],
                viewers: st.viewers || [],
                posted_at: toIso(st.timestamp || Date.now()),
                updated_at: new Date().toISOString()
            };
        }).filter(function (r) { return r.id; });
        const existing = await db.from("statuses").select("id").eq("tenant_id", tid);
        if (existing.error) return { ok: false, message: existing.error.message, missing: isMissingTable(existing.error) };
        const keep = {};
        rows.forEach(function (r) { keep[r.id] = true; });
        const gone = (existing.data || []).filter(function (r) { return !keep[r.id]; }).map(function (r) { return r.id; });
        if (rows.length) {
            const up = await db.from("statuses").upsert(rows, { onConflict: "tenant_id,id" });
            if (up.error) return { ok: false, message: up.error.message };
        }
        if (gone.length) await db.from("statuses").delete().eq("tenant_id", tid).in("id", gone);
        writeLocal(tid, "statuses", list);
        return { ok: true };
    };

    api.pullStatuses = async function (tenantId) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        const res = await db.from("statuses").select("*").eq("tenant_id", tid);
        if (res.error && isMissingTable(res.error)) return { ok: true, missing: true };
        if (res.error) return { ok: false, message: res.error.message };
        api.tables.statuses = true;
        if ((res.data || []).length) {
            writeLocal(tid, "statuses", (res.data || []).map(mapStatusRow));
        } else {
            try {
                const raw = localStorage.getItem("sb_tenant_" + tid + "_statuses");
                const local = raw ? JSON.parse(raw) : [];
                if (Array.isArray(local) && local.length) await api.saveStatuses(tid, local);
            } catch (e) {}
        }
        return { ok: true };
    };


    /* ---------- Role permissions (per company) ---------- */
    api.saveRolePermissions = async function (tenantId, map) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        const roles = Object.keys(map || {});
        const rows = roles.map(function (r) {
            return { tenant_id: tid, role: r, permissions: map[r] || {}, updated_at: new Date().toISOString() };
        });
        if (rows.length) {
            const up = await db.from("role_permissions").upsert(rows, { onConflict: "tenant_id,role" });
            if (up.error) return { ok: false, message: up.error.message, missing: isMissingTable(up.error) };
        }
        writeLocal(tid, "role_permissions", map || {});
        return { ok: true };
    };

    api.pullRolePermissions = async function (tenantId) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        const res = await db.from("role_permissions").select("role,permissions").eq("tenant_id", tid);
        if (res.error && isMissingTable(res.error)) return { ok: true, missing: true };
        if (res.error) return { ok: false, message: res.error.message };
        api.tables.roles = true;
        const map = {};
        (res.data || []).forEach(function (r) { map[r.role] = r.permissions || {}; });
        if (Object.keys(map).length) writeLocal(tid, "role_permissions", map);
        else {
            try {
                const raw = localStorage.getItem("sb_tenant_" + tid + "_role_permissions");
                const local = raw ? JSON.parse(raw) : {};
                if (local && Object.keys(local).length) await api.saveRolePermissions(tid, local);
            } catch (e) {}
        }
        return { ok: true };
    };

    /* ---------- Attendance ---------- */
    function sessionToRow(tid, userId, s) {
        return {
            tenant_id: tid,
            user_id: Number(userId),
            status: s.status || "offline",
            branch_name: s.branchName || null,
            login_time: toIso(s.loginTime),
            last_active: toIso(s.lastActive || Date.now())
        };
    }

    function punchToRow(tid, p) {
        return {
            tenant_id: tid,
            id: Number(p.id),
            user_id: Number(p.userId),
            user_name: p.userName || null,
            branch_name: p.branchName || null,
            login_time: toIso(p.loginTime),
            logout_time: toIso(p.logoutTime),
            duration_ms: p.duration == null ? null : Number(p.duration)
        };
    }

    api.upsertSession = async function (tenantId, userId, sess) {
        const tid = String(tenantId || "").trim();
        if (!tid || userId == null || !sess) return { ok: true };
        const res = await db.from("attendance_sessions").upsert(sessionToRow(tid, userId, sess), { onConflict: "tenant_id,user_id" });
        if (res.error) return { ok: false, message: res.error.message, missing: isMissingTable(res.error) };
        return { ok: true };
    };

    api.upsertPunch = async function (tenantId, punch) {
        const tid = String(tenantId || "").trim();
        if (!tid || !punch || punch.id == null) return { ok: true };
        const res = await db.from("attendance_punches").upsert(punchToRow(tid, punch), { onConflict: "tenant_id,id" });
        if (res.error) return { ok: false, message: res.error.message, missing: isMissingTable(res.error) };
        return { ok: true };
    };

    api.clearAttendance = async function (tenantId) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        const a = await db.from("attendance_punches").delete().eq("tenant_id", tid);
        if (a.error) return { ok: false, message: a.error.message, missing: isMissingTable(a.error) };
        await db.from("attendance_sessions").update({ status: "offline" }).eq("tenant_id", tid);
        return { ok: true };
    };

    api.pullAttendance = async function (tenantId) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        const ses = await db.from("attendance_sessions").select("*").eq("tenant_id", tid);
        if (ses.error && isMissingTable(ses.error)) return { ok: true, missing: true };
        if (ses.error) return { ok: false, message: ses.error.message };
        const pun = await db.from("attendance_punches").select("*").eq("tenant_id", tid)
            .order("login_time", { ascending: false }).limit(500);
        if (pun.error) return { ok: false, message: pun.error.message };
        api.tables.attendance = true;
        if ((ses.data || []).length) {
            const map = {};
            (ses.data || []).forEach(function (r) {
                map[r.user_id] = {
                    loginTime: toMs(r.login_time), lastActive: toMs(r.last_active),
                    status: r.status || "offline", branchName: r.branch_name || "Unknown"
                };
            });
            writeLocal(tid, "sessions", map);
        }
        if ((pun.data || []).length) {
            const list = (pun.data || []).map(function (r) {
                return {
                    id: Number(r.id), userId: Number(r.user_id), userName: r.user_name || "User",
                    branchName: r.branch_name || "Unknown", loginTime: toMs(r.login_time),
                    logoutTime: toMs(r.logout_time), duration: r.duration_ms == null ? null : Number(r.duration_ms)
                };
            }).sort(function (a, b) { return a.loginTime - b.loginTime; });
            writeLocal(tid, "punchHistory", list);
        } else {
            try {
                const raw = localStorage.getItem("sb_tenant_" + tid + "_punchHistory");
                const local = raw ? JSON.parse(raw) : [];
                for (let i = 0; i < local.length; i++) {
                    if (local[i].id == null) local[i].id = local[i].loginTime * 100 + (Number(local[i].userId) % 100);
                    await api.upsertPunch(tid, local[i]);
                }
            } catch (e) {}
        }
        return { ok: true };
    };


    /* ---------- Flutterwave payments + subscription ---------- */
    async function invokePay(payload) {
        const res = await db.functions.invoke("flutterwave", { body: payload });
        if (res.error) {
            let msg = res.error.message || "Payment request failed";
            try {
                if (res.error.context && typeof res.error.context.json === "function") {
                    const b = await res.error.context.json();
                    if (b && b.error) msg = b.error;
                    if (b && b.pending) return { ok: false, pending: true, message: msg };
                }
            } catch (e) {}
            if (functionUnavailable(msg)) msg = "The flutterwave Edge Function is not deployed yet.";
            return { ok: false, message: msg };
        }
        const data = res.data || {};
        if (data.error) return { ok: false, message: data.error, pending: !!data.pending };
        return { ok: true, data: data };
    }

    api.startCheckout = function (payload) {
        return invokePay(Object.assign({ action: "create_checkout" }, payload));
    };

    api.verifyPayment = function (txRef, transactionId) {
        return invokePay({ action: "verify", tx_ref: txRef, transaction_id: transactionId });
    };

    function applySubscriptionToTenant(tid, row) {
        try {
            const raw = localStorage.getItem("sb_tenants");
            const ts = raw ? JSON.parse(raw) : [];
            const t0 = ts.find(function (x) { return String(x.id) === String(tid); });
            if (!t0) return;
            const expiry = row && row.expires_at ? toMs(row.expires_at) : 0;
            const active = !!(row && row.status === "active" && expiry > Date.now());
            t0.plan = active ? "pro" : "free";
            t0.subscription = {
                active: active,
                expiry: expiry || 0,
                paidAmount: row ? Number(row.total_paid) || 0 : 0,
                paymentDate: row && row.last_payment_at ? toMs(row.last_payment_at) : null,
                plan: active ? "pro" : "free"
            };
            t0.trialExpired = true;
            t0.trialEnd = 0;
            localStorage.setItem("sb_tenants", JSON.stringify(ts));
        } catch (e) {}
    }

    api.pullSubscription = async function (tenantId) {
        const tid = String(tenantId || "").trim();
        if (!tid) return { ok: true };
        const res = await db.from("subscriptions").select("*").eq("tenant_id", tid).maybeSingle();
        if (res.error && isMissingTable(res.error)) return { ok: true, missing: true };
        if (res.error) return { ok: false, message: res.error.message };
        applySubscriptionToTenant(tid, res.data || null);
        return { ok: true };
    };

    api.pull = async function () {
        const res = await db.from("documents").select("scope,doc_key,data");
        if (res.error) {
            console.error("Supabase pull failed", res.error);
            return { ok: false, message: res.error.message };
        }
        (res.data || []).forEach(function (row) { writeLocal(row.scope, row.doc_key, row.data); });
        const profile = api.profile || (await loadProfile());
        if (profile && profile.tenant_id) {
            await api.pullInventory(profile.tenant_id);
            await api.pullExpenses(profile.tenant_id);
            await api.pullBranches(profile.tenant_id);
            await api.pullSales(profile.tenant_id);
            await api.pullStatuses(profile.tenant_id);
            await api.pullRolePermissions(profile.tenant_id);
            await api.pullAttendance(profile.tenant_id);
            await api.pullSubscription(profile.tenant_id);
        }
        if (profile) await api.pullAds();
        return { ok: true };
    };

    api.onSync = function (fn) {
        syncHandler = typeof fn === "function" ? fn : null;
    };

    function startRealtime() {
        if (channel) return;
        channel = db.channel("mex-documents")
            .on("postgres_changes", { event: "*", schema: "public", table: "documents" }, function (payload) {
                if (payload.eventType === "DELETE") return;
                applyRow(payload.new, true);
            })
            .on("postgres_changes", { event: "*", schema: "public", table: "products" }, function () {
                const tid = api.profile && api.profile.tenant_id;
                if (tid) api.pullInventory(tid).then(function () {
                    if (typeof syncHandler === "function") syncHandler({ scope: tid, doc_key: "products" });
                });
            })
            .on("postgres_changes", { event: "*", schema: "public", table: "categories" }, function () {
                const tid = api.profile && api.profile.tenant_id;
                if (tid) api.pullInventory(tid).then(function () {
                    if (typeof syncHandler === "function") syncHandler({ scope: tid, doc_key: "categories" });
                });
            })
            .on("postgres_changes", { event: "*", schema: "public", table: "expenses" }, function () {
                const tid = api.profile && api.profile.tenant_id;
                if (tid) api.pullExpenses(tid).then(function () {
                    if (typeof syncHandler === "function") syncHandler({ scope: tid, doc_key: "expenses" });
                });
            })
            .on("postgres_changes", { event: "*", schema: "public", table: "expense_categories" }, function () {
                const tid = api.profile && api.profile.tenant_id;
                if (tid) api.pullExpenses(tid).then(function () {
                    if (typeof syncHandler === "function") syncHandler({ scope: tid, doc_key: "expense_categories" });
                });
            })
            .on("postgres_changes", { event: "*", schema: "public", table: "branches" }, function () {
                const tid = api.profile && api.profile.tenant_id;
                if (tid) api.pullBranches(tid).then(function () {
                    if (typeof syncHandler === "function") syncHandler({ scope: tid, doc_key: "branches" });
                });
            })
            .on("postgres_changes", { event: "*", schema: "public", table: "sales" }, function () {
                const tid = api.profile && api.profile.tenant_id;
                if (tid) api.pullSales(tid).then(function () {
                    if (typeof syncHandler === "function") syncHandler({ scope: tid, doc_key: "sales" });
                });
            })
            .on("postgres_changes", { event: "*", schema: "public", table: "ads" }, function () {
                api.pullAds().then(function () {
                    if (typeof syncHandler === "function") syncHandler({ scope: "global", doc_key: "ads" });
                });
            })
            .on("postgres_changes", { event: "*", schema: "public", table: "role_permissions" }, function () {
                const tid = api.profile && api.profile.tenant_id;
                if (tid) api.pullRolePermissions(tid).then(function () {
                    if (typeof syncHandler === "function") syncHandler({ scope: tid, doc_key: "role_permissions" });
                });
            })
            .on("postgres_changes", { event: "*", schema: "public", table: "attendance_punches" }, function () {
                const tid = api.profile && api.profile.tenant_id;
                if (tid) api.pullAttendance(tid).then(function () {
                    if (typeof syncHandler === "function") syncHandler({ scope: tid, doc_key: "punchHistory" });
                });
            })
            .on("postgres_changes", { event: "*", schema: "public", table: "attendance_sessions" }, function (payload) {
                const tid = api.profile && api.profile.tenant_id;
                const row = payload.new;
                if (!tid || !row || String(row.tenant_id) !== String(tid)) return;
                let map = {};
                try { map = JSON.parse(localStorage.getItem("sb_tenant_" + tid + "_sessions") || "{}") || {}; } catch (e) {}
                const prev = map[row.user_id];
                map[row.user_id] = {
                    loginTime: toMs(row.login_time), lastActive: toMs(row.last_active),
                    status: row.status || "offline", branchName: row.branch_name || "Unknown"
                };
                writeLocal(tid, "sessions", map);
                if ((!prev || prev.status !== map[row.user_id].status) && typeof syncHandler === "function") {
                    syncHandler({ scope: tid, doc_key: "sessions" });
                }
            })
            .on("postgres_changes", { event: "*", schema: "public", table: "subscriptions" }, function () {
                const tid = api.profile && api.profile.tenant_id;
                if (tid) api.pullSubscription(tid).then(function () {
                    if (typeof syncHandler === "function") syncHandler({ scope: tid, doc_key: "subscription" });
                });
            })
            .on("postgres_changes", { event: "*", schema: "public", table: "statuses" }, function () {
                const tid = api.profile && api.profile.tenant_id;
                if (tid) api.pullStatuses(tid).then(function () {
                    if (typeof syncHandler === "function") syncHandler({ scope: tid, doc_key: "statuses" });
                });
            })
            .subscribe();
    }

    async function loadProfile() {
        const user = (await db.auth.getUser()).data.user;
        api.user = user || null;
        if (!user) { api.profile = null; return null; }
        const res = await db.from("profiles").select("*").eq("id", user.id).maybeSingle();
        api.profile = res.data || null;
        return api.profile;
    }

    function mapProfile(profile, authUser) {
        return {
            id: profile.app_user_id || profile.id,
            authId: profile.id,
            username: profile.username,
            fullName: profile.full_name || profile.username,
            role: profile.role,
            store: profile.store || (profile.role === "superadmin" ? "All" : null),
            phone: profile.phone || "",
            email: profile.email || (authUser && authUser.email) || "",
            photo: profile.photo_url || "",
            bio: profile.bio || "",
            socialWhatsapp: (profile.social && profile.social.socialWhatsapp) || "",
            socialInstagram: (profile.social && profile.social.socialInstagram) || "",
            socialFacebook: (profile.social && profile.social.socialFacebook) || "",
            socialTiktok: (profile.social && profile.social.socialTiktok) || "",
            socialWebsite: (profile.social && profile.social.socialWebsite) || "",
            theme: profile.theme || "light",
            lang: profile.lang || "en",
            tenantId: profile.tenant_id || null
        };
    }

    function persistMapped(profile, mapped) {
        if (profile.role === "mexemployee") {
            localStorage.setItem("sb_mex_current_employee", JSON.stringify(mapped));
        } else if (profile.role === "superadmin") {
            localStorage.setItem("sb___currentUser", JSON.stringify(mapped));
        } else if (profile.tenant_id) {
            localStorage.setItem("sb_tenant_" + profile.tenant_id + "__currentUser", JSON.stringify(mapped));
        }
    }

    api.prepare = async function () {
        const sessionRes = await db.auth.getSession();
        const session = sessionRes.data.session;
        api.hasSession = !!session;
        api.recovery = false;
        if (!session) return null;
        const hash = String(location.hash || "");
        if (hash.indexOf("type=recovery") !== -1) api.recovery = true;
        await api.pull();
        startRealtime();
        const profile = await loadProfile();
        if (!profile) return null;
        const mapped = mapProfile(profile, session.user);
        persistMapped(profile, mapped);
        return { profile: profile, user: mapped };
    };

    api.hasSuperadmin = async function () {
        const res = await db.rpc("has_superadmin");
        if (res.error) return true;
        return !!res.data;
    };

    api.signIn = async function (identifier, password) {
        const id = String(identifier || "").trim();
        let emails = [];
        if (id.indexOf("@") !== -1) emails = [id];
        else {
            const lookup = await db.rpc("login_emails", { identifier: id });
            if (lookup.error) return { ok: false, message: lookup.error.message };
            emails = (lookup.data || []).map(function (row) { return row.email; }).filter(Boolean);
        }
        if (!emails.length) return { ok: false, message: "Invalid username or password" };
        let lastError = "Invalid username or password";
        for (let i = 0; i < emails.length; i++) {
            const res = await db.auth.signInWithPassword({ email: emails[i], password: password });
            if (!res.error && res.data.session) {
                api.hasSession = true;
                api.user = res.data.user;
                startRealtime();
                return { ok: true };
            }
            if (res.error) lastError = res.error.message;
        }
        return { ok: false, message: lastError };
    };

    api.signOut = async function () {
        api.hasSession = false;
        api.user = null;
        api.profile = null;
        api.recovery = false;
        if (channel) {
            db.removeChannel(channel);
            channel = null;
        }
        await db.auth.signOut();
    };

    api.resetPassword = async function (identifier) {
        const id = String(identifier || "").trim();
        let emails = [];
        if (id.indexOf("@") !== -1) emails = [id];
        else {
            const lookup = await db.rpc("login_emails", { identifier: id });
            if (lookup.error) return { ok: false, message: lookup.error.message };
            emails = (lookup.data || []).map(function (row) { return row.email; }).filter(Boolean);
        }
        if (!emails.length) return { ok: false, message: "No account found for that username or email." };
        const res = await db.auth.resetPasswordForEmail(emails[0], { redirectTo: redirectTo() });
        if (res.error) return { ok: false, message: res.error.message };
        return { ok: true };
    };

    api.invoke = async function (payload) {
        const res = await db.functions.invoke("pos-admin", { body: payload });
        if (res.error) return { ok: false, message: invokeMessage(res.error), unavailable: functionUnavailable(res.error.message) };
        const data = res.data || {};
        if (data.error) return { ok: false, message: data.error };
        return { ok: true, data: data };
    };

    api.finalizeOwnerProfile = async function (payload) {
        if (!api.user) {
            const user = (await db.auth.getUser()).data.user;
            api.user = user || null;
        }
        return ensureProfile({
            username: String(payload.username || "").trim(),
            full_name: String(payload.company || payload.fullName || payload.username || "").trim(),
            phone: String(payload.phone || "").trim(),
            email: String(payload.email || "").trim().toLowerCase(),
            role: "owner",
            tenant_id: String(payload.tenantId || "").trim(),
            store: String(payload.company || payload.store || "").trim(),
            app_user_id: 1
        });
    };

    api.provisionCompany = async function (payload) {
        return api.invoke(Object.assign({ action: "provision_company" }, payload));
    };

    api.registerOwnerOnClient = async function (payload) {
        const username = String(payload.username || "").trim();
        const password = String(payload.password || "");
        const tenantId = String(payload.tenantId || "").trim();
        const company = String(payload.company || "").trim();
        const phone = String(payload.phone || "").trim();
        const email = String(payload.email || "").trim().toLowerCase();
        if (!company || !username || !tenantId) return { ok: false, message: "Company, username, and tenant are required." };
        if (!email || email.indexOf("@") === -1) return { ok: false, message: "A valid email is required." };
        if (password.length < 6) return { ok: false, message: "Password must be at least 6 characters." };
        const created = await db.auth.signUp({
            email: email,
            password: password,
            options: {
                emailRedirectTo: redirectTo(),
                data: {
                    username: username,
                    full_name: company,
                    role: "owner",
                    tenant_id: tenantId,
                    store: company,
                    phone: phone
                }
            }
        });
        if (created.error) return { ok: false, message: created.error.message };
        if (!created.data.session) {
            const login = await db.auth.signInWithPassword({ email: email, password: password });
            if (login.error) {
                const low = String(login.error.message || "").toLowerCase();
                if (low.indexOf("not confirmed") !== -1) {
                    return { ok: false, message: "Turn off Confirm email in Supabase → Authentication → Providers → Email, then try again." };
                }
                return { ok: false, message: login.error.message };
            }
        }
        api.hasSession = true;
        api.user = (await db.auth.getUser()).data.user;
        const saved = await ensureProfile({
            username: username,
            full_name: company,
            phone: phone,
            email: email,
            role: "owner",
            tenant_id: tenantId,
            store: company,
            app_user_id: 1
        });
        if (!saved.ok) return saved;
        return { ok: true, data: { tenantId: tenantId, email: email } };
    };

    api.registerCompany = async function (payload) {
        const viaFn = await api.invoke(Object.assign({ action: "register_company" }, payload));
        if (viaFn.ok) return viaFn;
        if (viaFn.unavailable) return api.registerOwnerOnClient(payload);
        return viaFn;
    };

    api.bootstrapSuperadmin = async function (payload) {
        const viaFn = await api.invoke(Object.assign({ action: "bootstrap_superadmin" }, payload));
        if (viaFn.ok) return viaFn;
        if (!viaFn.unavailable) return viaFn;
        const username = String(payload.username || "Mex").trim();
        const password = String(payload.password || "");
        const email = String(payload.email || "").trim().toLowerCase();
        const fullName = String(payload.fullName || "Super Admin").trim();
        if (!email || password.length < 6) return { ok: false, message: viaFn.message };
        const created = await db.auth.signUp({
            email: email,
            password: password,
            options: {
                emailRedirectTo: redirectTo(),
                data: { username: username, full_name: fullName, role: "superadmin", store: "All", phone: payload.phone || "" }
            }
        });
        if (created.error) return { ok: false, message: created.error.message };
        if (!created.data.session) {
            const login = await db.auth.signInWithPassword({ email: email, password: password });
            if (login.error) return { ok: false, message: "Account created. Turn off Confirm email in Supabase Auth, then sign in." };
        }
        api.hasSession = true;
        api.user = (await db.auth.getUser()).data.user;
        return ensureProfile({
            username: username,
            full_name: fullName,
            email: email,
            role: "superadmin",
            tenant_id: null,
            store: "All",
            app_user_id: 0
        });
    };

    api.createStaff = async function (user, password) {
        const res = await api.invoke({
            action: "create_staff",
            username: user.username,
            password: password,
            fullName: user.fullName || user.name || user.username,
            phone: user.phone || "",
            email: user.email || "",
            role: user.role || "employee",
            tenantId: user.tenantId || null,
            store: user.store || null,
            appUserId: user.id
        });
        if (!res.ok) return res;
        return { ok: true, authId: res.data && res.data.authId };
    };

    api.setPassword = async function (username, tenantId, password) {
        return api.invoke({ action: "set_password", username: username, tenantId: tenantId || null, password: password });
    };

    api.updateStaff = async function (username, tenantId, fields) {
        return api.invoke(Object.assign({ action: "update_staff", username: username, tenantId: tenantId || null }, fields || {}));
    };

    api.deleteStaff = async function (username, tenantId) {
        return api.invoke({ action: "delete_staff", username: username, tenantId: tenantId || null });
    };

    api.updateOwnPassword = async function (password) {
        const res = await db.auth.updateUser({ password: password });
        if (res.error) return { ok: false, message: res.error.message };
        api.recovery = false;
        return { ok: true };
    };

    api.saveProfile = async function (fields) {
        if (!api.user) await loadProfile();
        if (!api.user) return { ok: false, message: "Not signed in" };
        let res = await db.from("profiles").update(fields).eq("id", api.user.id);
        if (res.error && /bio|social|column|schema cache/i.test(res.error.message || "") && ("bio" in fields || "social" in fields)) {
            const rest = Object.assign({}, fields);
            delete rest.bio;
            delete rest.social;
            res = await db.from("profiles").update(rest).eq("id", api.user.id);
        }
        if (res.error) return { ok: false, message: res.error.message };
        if (api.profile) Object.assign(api.profile, fields);
        return { ok: true };
    };

    api.upload = async function (path, blob, contentType) {
        const res = await db.storage.from("pos-media").upload(path, blob, {
            upsert: true,
            contentType: contentType || blob.type || "application/octet-stream"
        });
        if (res.error) return { ok: false, message: res.error.message };
        const pub = db.storage.from("pos-media").getPublicUrl(path);
        return { ok: true, url: pub.data.publicUrl + "?v=" + Date.now() };
    };

    db.auth.onAuthStateChange(function (event, session) {
        api.hasSession = !!session;
        if (event === "PASSWORD_RECOVERY") api.recovery = true;
        if (event === "SIGNED_OUT") {
            api.user = null;
            api.profile = null;
            api.recovery = false;
        }
    });

    window.MexSupabase = api;
})();
