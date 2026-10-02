-- Inventory: products and categories stored per company, with images in Storage.

create or replace function public.can_access_tenant(tid text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.profiles p
        where p.id = auth.uid()
          and (
                p.role = 'superadmin'
             or (tid is not null and p.tenant_id is not null and p.tenant_id = tid)
          )
    )
$$;

create table if not exists public.categories (
    tenant_id text not null,
    id bigint not null,
    name text not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, id)
);

create unique index if not exists categories_tenant_name_uidx
    on public.categories (tenant_id, lower(name));

create table if not exists public.products (
    tenant_id text not null,
    id bigint not null,
    name text not null,
    description text not null default '',
    price numeric not null default 0,
    cost numeric not null default 0,
    quantity integer not null default 0,
    category text not null default 'General',
    store text,
    image_url text,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, id)
);

create index if not exists products_tenant_store_idx on public.products (tenant_id, store);

alter table public.categories enable row level security;
alter table public.products enable row level security;

drop policy if exists categories_all on public.categories;
create policy categories_all on public.categories
    for all to authenticated
    using (public.can_access_tenant(tenant_id))
    with check (public.can_access_tenant(tenant_id));

drop policy if exists products_all on public.products;
create policy products_all on public.products
    for all to authenticated
    using (public.can_access_tenant(tenant_id))
    with check (public.can_access_tenant(tenant_id));

alter table public.categories replica identity full;
alter table public.products replica identity full;

do $$
begin
    alter publication supabase_realtime add table public.categories;
exception
    when duplicate_object then null;
end $$;

do $$
begin
    alter publication supabase_realtime add table public.products;
exception
    when duplicate_object then null;
end $$;
