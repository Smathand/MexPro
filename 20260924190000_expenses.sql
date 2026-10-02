-- Expenses recorded per company, with optional receipt image in Storage.

create table if not exists public.expense_categories (
    tenant_id text not null,
    id bigint not null,
    name text not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, id)
);

create unique index if not exists expense_categories_tenant_name_uidx
    on public.expense_categories (tenant_id, lower(name));

create table if not exists public.expenses (
    tenant_id text not null,
    id bigint not null,
    description text not null,
    amount numeric not null default 0,
    category text not null default 'Other',
    store text,
    created_by text,
    spent_at timestamptz not null default now(),
    receipt_url text,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, id)
);

create index if not exists expenses_tenant_date_idx on public.expenses (tenant_id, spent_at desc);

alter table public.expense_categories enable row level security;
alter table public.expenses enable row level security;

drop policy if exists expense_categories_all on public.expense_categories;
create policy expense_categories_all on public.expense_categories
    for all to authenticated
    using (public.can_access_tenant(tenant_id))
    with check (public.can_access_tenant(tenant_id));

drop policy if exists expenses_all on public.expenses;
create policy expenses_all on public.expenses
    for all to authenticated
    using (public.can_access_tenant(tenant_id))
    with check (public.can_access_tenant(tenant_id));

alter table public.expense_categories replica identity full;
alter table public.expenses replica identity full;

do $$
begin
    alter publication supabase_realtime add table public.expense_categories;
exception
    when duplicate_object then null;
end $$;

do $$
begin
    alter publication supabase_realtime add table public.expenses;
exception
    when duplicate_object then null;
end $$;
