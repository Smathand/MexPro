-- Profile bio + social links, global ads (with promotion), and per-company statuses in Postgres.

alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists social jsonb not null default '{}'::jsonb;

create table if not exists public.ads (
    id bigint primary key,
    tenant_id text,
    posted_by text not null default 'company',
    author_user_id bigint,
    author_name text,
    company_name text,
    title text not null default '',
    content text not null default '',
    media_type text not null default 'none',
    media_url text,
    is_paid boolean not null default false,
    viewers jsonb not null default '[]'::jsonb,
    comments jsonb not null default '[]'::jsonb,
    promoted boolean not null default false,
    promoted_at timestamptz,
    promoted_until timestamptz,
    promotion_paid numeric not null default 0,
    promotion_plan text,
    promotion_payment_method text,
    posted_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists ads_tenant_idx on public.ads (tenant_id);
create index if not exists ads_posted_at_idx on public.ads (posted_at desc);

create table if not exists public.statuses (
    tenant_id text not null,
    id bigint not null,
    user_id bigint,
    text text not null default '',
    image_url text,
    likes jsonb not null default '[]'::jsonb,
    comments jsonb not null default '[]'::jsonb,
    viewers jsonb not null default '[]'::jsonb,
    posted_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, id)
);

create index if not exists statuses_tenant_date_idx on public.statuses (tenant_id, posted_at desc);

create or replace function public.is_superadmin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'superadmin')
$$;

alter table public.ads enable row level security;
alter table public.statuses enable row level security;

-- Ads are a shared feed: every signed-in user reads them and may update them
-- (comments, viewers). Only the owning company (or superadmin) posts or deletes.
drop policy if exists ads_select on public.ads;
create policy ads_select on public.ads
    for select to authenticated using (true);

drop policy if exists ads_insert on public.ads;
create policy ads_insert on public.ads
    for insert to authenticated
    with check (
        public.is_superadmin()
        or (tenant_id is not null and public.can_access_tenant(tenant_id))
    );

drop policy if exists ads_update on public.ads;
create policy ads_update on public.ads
    for update to authenticated using (true) with check (true);

drop policy if exists ads_delete on public.ads;
create policy ads_delete on public.ads
    for delete to authenticated
    using (
        public.is_superadmin()
        or (tenant_id is not null and public.can_access_tenant(tenant_id))
    );

drop policy if exists statuses_all on public.statuses;
create policy statuses_all on public.statuses
    for all to authenticated
    using (public.can_access_tenant(tenant_id))
    with check (public.can_access_tenant(tenant_id));

alter table public.ads replica identity full;
alter table public.statuses replica identity full;

do $$
begin
    alter publication supabase_realtime add table public.ads;
exception
    when duplicate_object then null;
end $$;

do $$
begin
    alter publication supabase_realtime add table public.statuses;
exception
    when duplicate_object then null;
end $$;
