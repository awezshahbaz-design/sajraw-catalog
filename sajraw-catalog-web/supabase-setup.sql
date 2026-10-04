-- Sajraw PDF Catalog Maker - run once in Supabase > SQL Editor > New query > Run

create table if not exists public.cars (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.settings (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Row Level Security: only the signed-in owner can see or change their rows
alter table public.cars     enable row level security;
alter table public.settings enable row level security;
drop policy if exists "own cars"     on public.cars;
drop policy if exists "own settings" on public.settings;
create policy "own cars"     on public.cars     for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own settings" on public.settings for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Private image bucket; each user can only touch files inside their own folder (<user id>/...)
insert into storage.buckets (id, name, public) values ('car-images', 'car-images', false) on conflict (id) do nothing;
drop policy if exists "own car images" on storage.objects;
create policy "own car images" on storage.objects for all to authenticated
  using      (bucket_id = 'car-images' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'car-images' and (storage.foldername(name))[1] = auth.uid()::text);
