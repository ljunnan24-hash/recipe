-- Recipe：用户档案（登录邮箱 + 引导/档案字段 JSON）
-- 在 Supabase SQL Editor 执行一次即可。

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  profile jsonb not null default '{}'::jsonb,
  selected_canteen text not null default 'none',
  updated_at timestamptz not null default now()
);

create index if not exists user_profiles_updated_at_idx on public.user_profiles (updated_at desc);

alter table public.user_profiles enable row level security;

-- 仅允许本人读写自己的档案
create policy "user_profiles_select_own"
on public.user_profiles
for select
to authenticated
using (auth.uid() = user_id);

create policy "user_profiles_insert_own"
on public.user_profiles
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "user_profiles_update_own"
on public.user_profiles
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- 可选：允许删除（一般不需要）
-- create policy "user_profiles_delete_own"
-- on public.user_profiles
-- for delete
-- to authenticated
-- using (auth.uid() = user_id);

-- 若客户端 upsert / 查询时报 permission denied for table user_profiles，在 SQL Editor 再执行下面一段（可重复执行）
grant usage on schema public to authenticated;
grant select, insert, update on table public.user_profiles to authenticated;
