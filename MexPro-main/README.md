# MexPro

Multi-tenant POS that stays a static site on GitHub Pages. **Accounts, company data, and media live in Supabase** (Auth, Postgres, Storage, and one Edge Function).

Until `js/supabase-config.js` has a project URL and anon key, the app keeps working in this browser only.

## 1. Create a Supabase project

1. Open [supabase.com](https://supabase.com) and create a project.
2. In **SQL Editor**, paste and run `supabase/migrations/20260924000000_init.sql`.
   If you already ran an older version of that file, also run `supabase/migrations/20260924010000_rls_auth.sql`.
   For inventory tables (products, categories, images), also run `supabase/migrations/20260924180000_inventory.sql`.
   For expenses (records, categories, receipt images), also run `supabase/migrations/20260924190000_expenses.sql`.
   For branches and per-location sales catalogs, also run `supabase/migrations/20260924200000_branches.sql`.
3. In **Authentication → Providers → Email**:
   - Keep Email enabled.
   - Turn **Confirm email** **off** so new company accounts can sign in immediately.
   - Set minimum password length to **6**.
4. In **Authentication → URL Configuration**, add your GitHub Pages URL as **Site URL** and under **Redirect URLs**:
   - `https://YOUR_USER.github.io/YOUR_REPO/`
   - `http://localhost:5500/` (or whatever you use locally)
5. Deploy the Edge Function named **`pos-admin`** (the **service role key stays on Supabase**, never in the browser).

**Easiest: Dashboard**
1. Open your project → **Edge Functions**.
2. **Create a new function**, name it exactly `pos-admin`.
3. Paste the contents of `supabase/functions/pos-admin/index.ts` and deploy.
4. Turn **Verify JWT** off for that function (the function checks the user itself).

**Or CLI:**

```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase functions deploy pos-admin --no-verify-jwt
```

Company owners can still register without the function (Auth + their profile). Deploy it so staff logins, demo users, and password resets work.

## 2. Connect the static app

From **Project Settings → API** copy the project URL and the **anon public** key.

### Local

Paste them into `js/supabase-config.js`:

```js
window.MEX_SUPABASE = {
    url: "https://YOUR_PROJECT.supabase.co",
    anonKey: "YOUR_ANON_KEY",
    redirectTo: "http://localhost:5500/"
};
```

### GitHub Pages

In the repo: **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
| --- | --- |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | anon public key |
| `SUPABASE_REDIRECT_TO` | `https://YOUR_USER.github.io/YOUR_REPO/` |

The Pages workflow writes those into `js/supabase-config.js` on each deploy.

## 3. First sign-in

Open the live site. If no super admin exists yet, the login card shows **Create Super Admin**. That creates a Supabase Auth user and a `profiles` row with `role = superadmin`.

Company owners register from the app. Each company gets Auth logins for the owner plus demo staff (`admin` / `admin123`, `employee` / `emp123`, `accountant` / `acc123`). MeX staff accounts are created from the Super Admin screen and also get a Supabase login.

Sign-in accepts a **username or email**. Passwords live in Supabase Auth, not in the POS documents.

## What syncs

| Feature | Where it lives |
| --- | --- |
| Logins, password reset | Supabase Auth |
| Name, role, phone, company, photo URL | `profiles` |
| Products, quantities, images, and categories | `products` and `categories` tables, images in `pos-media` |
| Sales, expenses, users list, chat, attendance, tenants | `documents` (JSON per company) |
| Profile photos, ads, chat files | Storage bucket `pos-media` |
| Create company / staff / reset another user's password | Edge Function `pos-admin` |

Signed-in devices pull company data on load and keep writing through `localStorage` with a background upsert, plus realtime updates when another tab or till changes a document.

Row Level Security keeps one company from reading another company's sales, stock, or staff list. Global ads and the tenant directory stay shared so the status feed still works.

## Super admin from the dashboard (optional)

Create the user in **Authentication**, then in SQL:

```sql
update public.profiles
set role = 'superadmin', store = 'All'
where id = '<auth user uuid>';
```

## Payments & subscription (Flutterwave)

Plans: **Free** (0 TSh) and **Pro** (1,000 TSh / 30 days). Both include every feature while the app is in testing.
Ad promotion is paid separately (4,990 TSh for 48 hours, 9,990 TSh for 1 week). Payments use Flutterwave hosted checkout
(Tanzania mobile money and card, currency TZS). Prices and fulfilment live in `supabase/functions/flutterwave`, never in the browser.

Setup:

1. Run the migrations in `supabase/migrations/` (the newest creates `payments` and `subscriptions`).
2. In Flutterwave, enable **Tanzania mobile money** and **card** for TZS, then copy your API keys.
3. Set the function secrets and deploy:

   ```bash
   supabase secrets set FLW_SECRET_KEY=FLWSECK_TEST-xxxx FLW_SECRET_HASH=choose-a-long-random-string
   supabase secrets set APP_ORIGINS=https://your-site.example   # recommended: allowed return origin(s)
   supabase functions deploy flutterwave
   ```

4. In Flutterwave → Settings → Webhooks, set the URL to
   `https://<project-ref>.supabase.co/functions/v1/flutterwave` and the **secret hash** to the same `FLW_SECRET_HASH`.
   The webhook is a safety net; the app also confirms the payment itself when the customer returns from checkout.

Use test keys first (test-mode Tanzania mobile money approves automatically), then switch to live keys.
