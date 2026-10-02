-- Allow a signed-in user to create their own profile when the edge function is not deployed.

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
    for insert to authenticated
    with check (id = auth.uid());
