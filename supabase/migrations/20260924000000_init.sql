-- MeX PRO: auth profiles, POS documents, and media storage.
-- Run in the Supabase SQL editor, or with `supabase db push`.

create table if not exists public.profiles (
    id uuid primary key references auth.users (id) on delete cascade,
    username text not null,
    full_name text,
    phone text,
    email text,
    role text not null default 'employee',
    tenant_id text,
    store text,
    photo_url text,
    theme text default 'light',
    lang text default 'en',
    app_user_id bigint,
    created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists email text;

create unique index if not exists profiles_username_tenant_uidx
    on public.profiles (lower(username), coalesce(tenant_id, ''));

create table if not exists public.documents (
    scope text not null,
    doc_key text not null,
    data jsonb not null,
    updated_at timestamptz not null default now(),
    primary key (scope, doc_key)
);

alter table public.profiles enable row level security;
alter table public.documents enable row level security;

create or replace function public.current_profile()
returns public.profiles
language sql
stable
security definer
set search_path = public
as $$
    select * from public.profiles where id = auth.uid()
$$;

create or replace function public.has_superadmin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (select 1 from public.profiles where role = 'superadmin')
$$;

revoke all on function public.has_superadmin() from public;
grant execute on function public.has_superadmin() to anon, authenticated;

create or replace function public.can_access_document(doc_scope text, doc_key text)
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
             or (doc_scope is not null and p.tenant_id is not null and doc_scope = p.tenant_id)
             or (doc_scope = 'global' and doc_key in ('tenants', 'ads'))
             or (doc_scope = 'global' and doc_key = 'mex_employees' and p.role in ('superadmin', 'mexemployee'))
             or doc_key in ('follows', 'company')
          )
    )
$$;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
    for select to authenticated
    using (
        id = auth.uid()
        or coalesce((select role from public.current_profile()), '') = 'superadmin'
        or (
            coalesce((select tenant_id from public.current_profile()), '') <> ''
            and (select tenant_id from public.current_profile()) = profiles.tenant_id
        )
        or (
            coalesce((select role from public.current_profile()), '') = 'mexemployee'
            and profiles.role in ('mexemployee', 'superadmin')
        )
    );

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
    for update to authenticated
    using (id = auth.uid())
    with check (id = auth.uid());

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
    for insert to authenticated
    with check (id = auth.uid());

drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents
    for select to authenticated
    using (public.can_access_document(scope, doc_key));

drop policy if exists documents_write on public.documents;
create policy documents_write on public.documents
    for all to authenticated
    using (public.can_access_document(scope, doc_key))
    with check (public.can_access_document(scope, doc_key));

create or replace function public.login_emails(identifier text)
returns table (email text)
language sql
security definer
set search_path = public
as $$
    select u.email::text
    from auth.users u
    join public.profiles p on p.id = u.id
    where lower(p.username) = lower(trim(identifier))
       or lower(u.email::text) = lower(trim(identifier))
       or lower(coalesce(p.email, '')) = lower(trim(identifier));
$$;

revoke all on function public.login_emails(text) from public;
grant execute on function public.login_emails(text) to anon, authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles (id, username, full_name, email, role, tenant_id, store, phone)
    values (
        new.id,
        coalesce(nullif(trim(new.raw_user_meta_data->>'username'), ''), split_part(new.email, '@', 1)),
        coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'), ''), new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
        new.email,
        coalesce(nullif(trim(new.raw_user_meta_data->>'role'), ''), 'employee'),
        nullif(trim(new.raw_user_meta_data->>'tenant_id'), ''),
        nullif(trim(new.raw_user_meta_data->>'store'), ''),
        nullif(trim(new.raw_user_meta_data->>'phone'), '')
    )
    on conflict (id) do update
        set email = excluded.email,
            username = coalesce(public.profiles.username, excluded.username);
    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();

alter table public.documents replica identity full;
do $$
begin
    alter publication supabase_realtime add table public.documents;
exception
    when duplicate_object then null;
end $$;

insert into storage.buckets (id, name, public)
values ('pos-media', 'pos-media', true)
on conflict (id) do update set public = true;

drop policy if exists pos_media_read on storage.objects;
create policy pos_media_read on storage.objects
    for select to public
    using (bucket_id = 'pos-media');

drop policy if exists pos_media_insert on storage.objects;
create policy pos_media_insert on storage.objects
    for insert to authenticated
    with check (bucket_id = 'pos-media');

drop policy if exists pos_media_update on storage.objects;
create policy pos_media_update on storage.objects
    for update to authenticated
    using (bucket_id = 'pos-media');

drop policy if exists pos_media_delete on storage.objects;
create policy pos_media_delete on storage.objects
    for delete to authenticated
    using (bucket_id = 'pos-media');
