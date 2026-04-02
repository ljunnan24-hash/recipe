-- 每日饮食记录、饮水、按日事件 + 健康报告（登录用户云端同步）
-- 在 Supabase SQL Editor 中粘贴全文执行（不要只写文件路径）

-- 按「用户 + 日期」一条记录（date_key 格式 YYYY-MM-DD，与前端 todayKey 一致）
create table if not exists public.user_daily_log (
  user_id uuid not null references auth.users (id) on delete cascade,
  date_key text not null,
  intake jsonb not null default '[]',
  water_ml integer not null default 0,
  events jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  primary key (user_id, date_key)
);

create index if not exists user_daily_log_user_updated_idx
  on public.user_daily_log (user_id, updated_at desc);

alter table public.user_daily_log enable row level security;

drop policy if exists "user_daily_log_select_own" on public.user_daily_log;
drop policy if exists "user_daily_log_insert_own" on public.user_daily_log;
drop policy if exists "user_daily_log_update_own" on public.user_daily_log;

create policy "user_daily_log_select_own"
on public.user_daily_log
for select
to authenticated
using (auth.uid() = user_id);

create policy "user_daily_log_insert_own"
on public.user_daily_log
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "user_daily_log_update_own"
on public.user_daily_log
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- 健康报告：每用户最新一份
create table if not exists public.user_health_report (
  user_id uuid primary key references auth.users (id) on delete cascade,
  report jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.user_health_report enable row level security;

drop policy if exists "user_health_report_select_own" on public.user_health_report;
drop policy if exists "user_health_report_insert_own" on public.user_health_report;
drop policy if exists "user_health_report_update_own" on public.user_health_report;

create policy "user_health_report_select_own"
on public.user_health_report
for select
to authenticated
using (auth.uid() = user_id);

create policy "user_health_report_insert_own"
on public.user_health_report
for insert
to authenticated
with check (auth.uid() = user_id);

create policy "user_health_report_update_own"
on public.user_health_report
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

grant usage on schema public to authenticated;
grant select, insert, update on table public.user_daily_log to authenticated;
grant select, insert, update on table public.user_health_report to authenticated;
