-- Role-based access control (per-company editable role permissions) and attendance in Postgres.

-- ---------------------------------------------------------------------------
-- Role permissions
-- ---------------------------------------------------------------------------
create table if not exists public.role_permissions (
    tenant_id text not null,
    role text not null,
    permissions jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, role)
);

-- Built-in defaults (must match DEFAULT_ROLE_PERMS in index.html).
create or replace function public.default_role_permission(r text, perm text)
returns boolean
language sql
immutable
as $$
    select case r
        when 'owner' then true
        when 'admin' then perm in (
            'sales_create','sales_delete','inventory_view','inventory_manage',
            'expenses_view','expenses_manage','reports_view','pnl_view',
            'users_manage','attendance_view')
        when 'accountant' then perm in (
            'sales_create','sales_delete','inventory_view','inventory_manage',
            'expenses_view','expenses_manage','reports_view','pnl_view')
        when 'employee' then perm in (
            'sales_create','inventory_view','expenses_view','expenses_manage',
            'reports_view','pnl_view')
        else false
    end
$$;

-- Does the signed-in user hold `perm` inside company `tid`?
-- Owners always do; superadmin always does; others use the company override
-- row if present, else the built-in default. `roles_manage` and
-- `branches_manage` are owner-only and can never be delegated.
create or replace function public.has_permission(tid text, perm text)
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
             or (
                    tid is not null and p.tenant_id is not null and p.tenant_id = tid
                and (
                        p.role = 'owner'
                     or (
                            perm not in ('roles_manage', 'branches_manage')
                        and coalesce(
                                (select (rp.permissions ->> perm)::boolean
                                   from public.role_permissions rp
                                  where rp.tenant_id = tid and rp.role = p.role),
                                public.default_role_permission(p.role, perm)
                            )
                        )
                    )
                )
          )
    )
$$;

create or replace function public.my_app_user_id()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
    select app_user_id from public.profiles where id = auth.uid()
$$;

alter table public.role_permissions enable row level security;

drop policy if exists role_permissions_select on public.role_permissions;
create policy role_permissions_select on public.role_permissions
    for select to authenticated using (public.can_access_tenant(tenant_id));

drop policy if exists role_permissions_write on public.role_permissions;
create policy role_permissions_write on public.role_permissions
    for all to authenticated
    using (public.has_permission(tenant_id, 'roles_manage'))
    with check (public.has_permission(tenant_id, 'roles_manage'));

alter table public.role_permissions replica identity full;
do $$
begin
    alter publication supabase_realtime add table public.role_permissions;
exception
    when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Enforce permissions on existing tenant tables (server-side, not just UI)
-- ---------------------------------------------------------------------------

-- Products: stock is decremented by sales, so sales_create may update/insert.
drop policy if exists products_all on public.products;
drop policy if exists products_select on public.products;
create policy products_select on public.products
    for select to authenticated using (public.can_access_tenant(tenant_id));
drop policy if exists products_insert on public.products;
create policy products_insert on public.products
    for insert to authenticated
    with check (public.has_permission(tenant_id, 'inventory_manage') or public.has_permission(tenant_id, 'sales_create'));
drop policy if exists products_update on public.products;
create policy products_update on public.products
    for update to authenticated
    using (public.has_permission(tenant_id, 'inventory_manage') or public.has_permission(tenant_id, 'sales_create'))
    with check (public.has_permission(tenant_id, 'inventory_manage') or public.has_permission(tenant_id, 'sales_create'));
drop policy if exists products_delete on public.products;
create policy products_delete on public.products
    for delete to authenticated using (public.has_permission(tenant_id, 'inventory_manage'));

drop policy if exists categories_all on public.categories;
drop policy if exists categories_select on public.categories;
create policy categories_select on public.categories
    for select to authenticated using (public.can_access_tenant(tenant_id));
drop policy if exists categories_write on public.categories;
create policy categories_write on public.categories
    for all to authenticated
    using (public.has_permission(tenant_id, 'inventory_manage'))
    with check (public.has_permission(tenant_id, 'inventory_manage'));

-- Expenses
drop policy if exists expenses_all on public.expenses;
drop policy if exists expenses_select on public.expenses;
create policy expenses_select on public.expenses
    for select to authenticated using (public.has_permission(tenant_id, 'expenses_view'));
drop policy if exists expenses_write on public.expenses;
create policy expenses_write on public.expenses
    for all to authenticated
    using (public.has_permission(tenant_id, 'expenses_manage'))
    with check (public.has_permission(tenant_id, 'expenses_manage'));

drop policy if exists expense_categories_all on public.expense_categories;
drop policy if exists expense_categories_select on public.expense_categories;
create policy expense_categories_select on public.expense_categories
    for select to authenticated using (public.can_access_tenant(tenant_id));
drop policy if exists expense_categories_write on public.expense_categories;
create policy expense_categories_write on public.expense_categories
    for all to authenticated
    using (public.has_permission(tenant_id, 'expenses_manage'))
    with check (public.has_permission(tenant_id, 'expenses_manage'));

-- Sales
drop policy if exists sales_all on public.sales;
drop policy if exists sales_select on public.sales;
create policy sales_select on public.sales
    for select to authenticated using (public.can_access_tenant(tenant_id));
drop policy if exists sales_insert on public.sales;
create policy sales_insert on public.sales
    for insert to authenticated with check (public.has_permission(tenant_id, 'sales_create'));
drop policy if exists sales_update on public.sales;
create policy sales_update on public.sales
    for update to authenticated
    using (public.has_permission(tenant_id, 'sales_create'))
    with check (public.has_permission(tenant_id, 'sales_create'));
drop policy if exists sales_delete on public.sales;
create policy sales_delete on public.sales
    for delete to authenticated using (public.has_permission(tenant_id, 'sales_delete'));

-- Branches: owner (or superadmin) only for writes.
drop policy if exists branches_all on public.branches;
drop policy if exists branches_select on public.branches;
create policy branches_select on public.branches
    for select to authenticated using (public.can_access_tenant(tenant_id));
drop policy if exists branches_write on public.branches;
create policy branches_write on public.branches
    for all to authenticated
    using (public.has_permission(tenant_id, 'branches_manage'))
    with check (public.has_permission(tenant_id, 'branches_manage'));

-- ---------------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------------
-- Live presence: one row per user.
create table if not exists public.attendance_sessions (
    tenant_id text not null,
    user_id bigint not null,
    status text not null default 'offline',
    branch_name text,
    login_time timestamptz,
    last_active timestamptz not null default now(),
    primary key (tenant_id, user_id)
);

-- Punch in / out history.
create table if not exists public.attendance_punches (
    tenant_id text not null,
    id bigint not null,
    user_id bigint not null,
    user_name text,
    branch_name text,
    login_time timestamptz not null,
    logout_time timestamptz,
    duration_ms bigint,
    primary key (tenant_id, id)
);

create index if not exists attendance_punches_tenant_time_idx
    on public.attendance_punches (tenant_id, login_time desc);

alter table public.attendance_sessions enable row level security;
alter table public.attendance_punches enable row level security;

-- Everyone in the company can see who is online (chat, users list).
drop policy if exists attendance_sessions_select on public.attendance_sessions;
create policy attendance_sessions_select on public.attendance_sessions
    for select to authenticated using (public.can_access_tenant(tenant_id));

drop policy if exists attendance_sessions_write on public.attendance_sessions;
create policy attendance_sessions_write on public.attendance_sessions
    for all to authenticated
    using (
        public.can_access_tenant(tenant_id)
        and (user_id = coalesce(public.my_app_user_id(), -1) or public.has_permission(tenant_id, 'attendance_view'))
    )
    with check (
        public.can_access_tenant(tenant_id)
        and (user_id = coalesce(public.my_app_user_id(), -1) or public.has_permission(tenant_id, 'attendance_view'))
    );

-- History: own rows, or everyone's for roles with attendance_view.
drop policy if exists attendance_punches_select on public.attendance_punches;
create policy attendance_punches_select on public.attendance_punches
    for select to authenticated
    using (
        public.can_access_tenant(tenant_id)
        and (user_id = coalesce(public.my_app_user_id(), -1) or public.has_permission(tenant_id, 'attendance_view'))
    );

drop policy if exists attendance_punches_write on public.attendance_punches;
create policy attendance_punches_write on public.attendance_punches
    for insert to authenticated
    with check (
        public.can_access_tenant(tenant_id)
        and (user_id = coalesce(public.my_app_user_id(), -1) or public.has_permission(tenant_id, 'attendance_view'))
    );

drop policy if exists attendance_punches_update on public.attendance_punches;
create policy attendance_punches_update on public.attendance_punches
    for update to authenticated
    using (
        public.can_access_tenant(tenant_id)
        and (user_id = coalesce(public.my_app_user_id(), -1) or public.has_permission(tenant_id, 'attendance_view'))
    )
    with check (
        public.can_access_tenant(tenant_id)
        and (user_id = coalesce(public.my_app_user_id(), -1) or public.has_permission(tenant_id, 'attendance_view'))
    );

drop policy if exists attendance_punches_delete on public.attendance_punches;
create policy attendance_punches_delete on public.attendance_punches
    for delete to authenticated using (public.has_permission(tenant_id, 'attendance_view'));

alter table public.attendance_sessions replica identity full;
alter table public.attendance_punches replica identity full;

do $$
begin
    alter publication supabase_realtime add table public.attendance_sessions;
exception
    when duplicate_object then null;
end $$;

do $$
begin
    alter publication supabase_realtime add table public.attendance_punches;
exception
    when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Profile hardening: nobody can promote themselves or move to another company.
-- Calls without a user JWT (service role / dashboard / auth triggers) are unaffected.
-- ---------------------------------------------------------------------------
create or replace function public.profiles_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is null then
        return new;
    end if;

    if tg_op = 'INSERT' then
        if new.role = 'superadmin' then
            if public.has_superadmin() then
                raise exception 'A superadmin already exists.';
            end if;
        elsif new.role = 'owner' then
            if new.tenant_id is null
               or exists (select 1 from public.profiles p where p.role = 'owner' and p.tenant_id = new.tenant_id) then
                raise exception 'That company already has an owner.';
            end if;
        else
            raise exception 'Role % cannot be self-assigned.', new.role;
        end if;
        return new;
    end if;

    if (new.role is distinct from old.role
        or new.tenant_id is distinct from old.tenant_id
        or new.app_user_id is distinct from old.app_user_id)
       and not public.is_superadmin() then
        raise exception 'Role and company can only be changed by an administrator.';
    end if;
    return new;
end;
$$;

drop trigger if exists profiles_guard_trg on public.profiles;
create trigger profiles_guard_trg
    before insert or update on public.profiles
    for each row execute procedure public.profiles_guard();
