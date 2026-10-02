-- Branches, per-branch catalogs, and sales persisted in Postgres.

create table if not exists public.branches (
    tenant_id text not null,
    id bigint not null,
    name text not null,
    address text,
    tin text,
    is_main boolean not null default false,
    subscription jsonb,
    permissions jsonb,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, id)
);

create unique index if not exists branches_tenant_name_uidx
    on public.branches (tenant_id, lower(name));

create table if not exists public.sales (
    tenant_id text not null,
    id bigint not null,
    product_id bigint,
    quantity integer not null default 1,
    unit_price numeric not null default 0,
    orig_unit_price numeric not null default 0,
    discount numeric not null default 0,
    total_price numeric not null default 0,
    total_cost numeric not null default 0,
    customer text,
    store text,
    created_by text,
    sold_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, id)
);

create index if not exists sales_tenant_store_date_idx
    on public.sales (tenant_id, store, sold_at desc);

alter table public.categories add column if not exists store text;
alter table public.expense_categories add column if not exists store text;

drop index if exists public.categories_tenant_name_uidx;
create unique index if not exists categories_tenant_store_name_uidx
    on public.categories (tenant_id, lower(coalesce(store, '')), lower(name));

drop index if exists public.expense_categories_tenant_name_uidx;
create unique index if not exists expense_categories_tenant_store_name_uidx
    on public.expense_categories (tenant_id, lower(coalesce(store, '')), lower(name));

alter table public.branches enable row level security;
alter table public.sales enable row level security;

drop policy if exists branches_all on public.branches;
create policy branches_all on public.branches
    for all to authenticated
    using (public.can_access_tenant(tenant_id))
    with check (public.can_access_tenant(tenant_id));

drop policy if exists sales_all on public.sales;
create policy sales_all on public.sales
    for all to authenticated
    using (public.can_access_tenant(tenant_id))
    with check (public.can_access_tenant(tenant_id));

alter table public.branches replica identity full;
alter table public.sales replica identity full;

do $$
begin
    alter publication supabase_realtime add table public.branches;
exception
    when duplicate_object then null;
end $$;

do $$
begin
    alter publication supabase_realtime add table public.sales;
exception
    when duplicate_object then null;
end $$;
