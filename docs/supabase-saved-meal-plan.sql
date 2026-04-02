-- 用户「保存到今日」时同步的三餐方案（每用户保留最新一条，下次登录可在「方案」页恢复）
-- 在 Supabase SQL Editor 执行一次即可。

create table if not exists public.user_saved_meal_plan (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan jsonb not null,
  selected_canteen text not null default 'none',
  updated_at timestamptz not null default now()
);

alter table public.user_saved_meal_plan enable row level security;

drop policy if exists "user_saved_meal_plan_select_own" on public.user_saved_meal_plan;
drop policy if exists "user_saved_meal_plan_insert_own" on public.user_saved_meal_plan;
drop policy if exists "user_saved_meal_plan_update_own" on public.user_saved_meal_plan;

create policy "user_saved_meal_plan_select_own"
on public.user_saved_meal_plan
for select
to authenticated
using (auth.uid() = user_id);

create policy "user_saved_meal_plan_insert_own"
on public.user_saved_meal_plan
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "user_saved_meal_plan_update_own"
on public.user_saved_meal_plan
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

grant usage on schema public to authenticated;
grant select, insert, update on table public.user_saved_meal_plan to authenticated;
