-- Flutterwave payments, company subscriptions (free / pro) and protected ad promotion.
-- Payments, subscriptions and promotion fields are written ONLY by the `flutterwave`
-- edge function (service role) after it has verified the payment with Flutterwave.

create table if not exists public.payments (
    tx_ref text primary key,
    tenant_id text,
    profile_id uuid,
    kind text not null,                 -- 'subscription' | 'ad_promotion'
    ref_id text,                        -- ad id for ad_promotion
    plan text not null,
    amount numeric not null,
    currency text not null default 'TZS',
    status text not null default 'pending',   -- pending | successful | failed
    flw_transaction_id text,
    payment_type text,
    created_at timestamptz not null default now(),
    paid_at timestamptz
);

create index if not exists payments_tenant_idx on public.payments (tenant_id, created_at desc);

create table if not exists public.subscriptions (
    tenant_id text primary key,
    plan text not null default 'free',  -- 'free' | 'pro'
    status text not null default 'inactive',
    started_at timestamptz,
    expires_at timestamptz,
    total_paid numeric not null default 0,
    last_payment_at timestamptz,
    updated_at timestamptz not null default now()
);

alter table public.payments enable row level security;
alter table public.subscriptions enable row level security;

-- Members of a company can read its payments / subscription. No client writes.
drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments
    for select to authenticated using (tenant_id is not null and public.can_access_tenant(tenant_id));

drop policy if exists subscriptions_select on public.subscriptions;
create policy subscriptions_select on public.subscriptions
    for select to authenticated using (public.can_access_tenant(tenant_id));

alter table public.subscriptions replica identity full;
do $$
begin
    alter publication supabase_realtime add table public.subscriptions;
exception
    when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Ads: promotion can only be switched on by the payment function (or superadmin).
-- Clients keep updating comments / viewers as before.
-- ---------------------------------------------------------------------------
create or replace function public.ads_protect_promotion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is null or public.is_superadmin() then
        return new;
    end if;
    if tg_op = 'INSERT' then
        new.promoted := false;
        new.promoted_at := null;
        new.promoted_until := null;
        new.promotion_paid := 0;
        new.promotion_plan := null;
        new.promotion_payment_method := null;
    else
        new.promoted := old.promoted;
        new.promoted_at := old.promoted_at;
        new.promoted_until := old.promoted_until;
        new.promotion_paid := old.promotion_paid;
        new.promotion_plan := old.promotion_plan;
        new.promotion_payment_method := old.promotion_payment_method;
    end if;
    return new;
end;
$$;

drop trigger if exists ads_protect_promotion_trg on public.ads;
create trigger ads_protect_promotion_trg
    before insert or update on public.ads
    for each row execute procedure public.ads_protect_promotion();
