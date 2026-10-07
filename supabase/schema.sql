-- SAMBA Browser 2b단계 스키마. Supabase 대시보드 > SQL Editor 에 통째로 붙여넣고 Run.
-- 몇 번을 다시 실행해도 안전하다(create if not exists / drop policy if exists).

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  created_at timestamptz not null default now()
);

-- workspaces 표는 2b 에서 앱이 쓰지 않는다(2c 예정).
-- 2b 에서 기기 간 공유 대상은 **기본 작업공간 하나**이고, 그 원격 uuid 는 모든 PC 가 쓰는
-- 고정값('00000000-0000-4000-8000-000000000001')이다 — PC 마다 새로 만들면 풀 필터
-- (workspace_id 일치)에 걸려 두 번째 PC 로 아무것도 내려오지 않는다.
-- 추가 작업공간만 PC 로컬에서 uuid 를 만들어 sync_state 에 고정한다(기기 간 공유 안 함).
-- 어느 쪽이든 이 표에는 행이 올라가지 않고, 다른 표의 workspace_id 가 그 uuid 를 그대로 담는다
create table if not exists public.workspaces (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.devices (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  os text,
  app_version text,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists public.settings_sync (
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, workspace_id, key)
);

create table if not exists public.accounts_sync (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  host text not null,
  label text not null,
  username text not null,
  is_default boolean not null default false,
  urls jsonb not null default '[]'::jsonb,
  agent_access text not null default 'inherit',
  tags jsonb not null default '[]'::jsonb,
  paused_until timestamptz,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 평문 비밀값 컬럼은 존재하지 않는다. label 만 사용자 지정 이름이라 평문이다.
create table if not exists public.vault_items_sync (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  account_id uuid,
  type text not null,
  label text not null,
  fields_ciphertext bytea not null,
  iv bytea not null,
  aad text not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.bookmarks_sync (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  folder_path text not null default '',
  title text not null,
  url text not null,
  position integer not null default 0,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- AI 채팅 기록. 본문은 평문이다(채팅은 비밀값이 아니다).
-- steps 는 진행 로그이고 라벨(label/ok/key)만 담는다 — 평문 비밀값이 들어갈 칸이 없다.
create table if not exists public.chats_sync (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  title text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.chat_messages_sync (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  chat_id uuid,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null default '',
  steps jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 4단계(자동화 레시피)용 자리. 2b 에서는 읽지도 쓰지도 않는다.
create table if not exists public.recipes (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  name text not null,
  prompt text,
  rules jsonb not null default '{}'::jsonb,
  procedure jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists accounts_sync_pull_idx on public.accounts_sync (user_id, updated_at);
create index if not exists vault_items_sync_pull_idx on public.vault_items_sync (user_id, updated_at);
create index if not exists bookmarks_sync_pull_idx on public.bookmarks_sync (user_id, updated_at);
create index if not exists settings_sync_pull_idx on public.settings_sync (user_id, updated_at);
create index if not exists chats_sync_pull_idx on public.chats_sync (user_id, updated_at);
create index if not exists chat_messages_sync_pull_idx on public.chat_messages_sync (user_id, updated_at);
create index if not exists chat_messages_sync_chat_idx on public.chat_messages_sync (user_id, chat_id);
create index if not exists workspaces_pull_idx on public.workspaces (user_id, updated_at);

-- === 행 수준 보안 ========================================================
alter table public.profiles        enable row level security;
alter table public.workspaces      enable row level security;
alter table public.devices         enable row level security;
alter table public.settings_sync   enable row level security;
alter table public.accounts_sync   enable row level security;
alter table public.vault_items_sync enable row level security;
alter table public.bookmarks_sync  enable row level security;
alter table public.chats_sync      enable row level security;
alter table public.chat_messages_sync enable row level security;
alter table public.recipes         enable row level security;

-- profiles 는 자기 자신(id = auth.uid())만
drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;
drop policy if exists profiles_delete on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_insert on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_delete on public.profiles for delete to authenticated using (id = auth.uid());

-- 나머지 테이블은 전부 user_id = auth.uid() 4종 정책
do $$
declare t text;
begin
  foreach t in array array['workspaces','devices','settings_sync','accounts_sync','vault_items_sync','bookmarks_sync','chats_sync','chat_messages_sync','recipes']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (user_id = auth.uid())', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (user_id = auth.uid())', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (user_id = auth.uid())', t || '_delete', t);
  end loop;
end $$;

-- anon 롤에는 어떤 권한도 주지 않는다(정책이 authenticated 전용이라 anon 은 0행을 본다).
revoke all on all tables in schema public from anon;

-- 가입 즉시 profiles 행을 만든다
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, coalesce(new.email, ''), new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Realtime (2026-10-06): 다른 PC 의 변경을 1분 폴링이 아니라 즉시 받으려면 동기화 표가 supabase_realtime
-- publication 에 들어 있어야 한다. 앱은 postgres_changes 로 이 표들을 구독한다(src/main/sync/supabase-backend.ts).
-- 이미 들어 있으면 오류가 나므로 예외를 삼키고 넘어간다.
do $$
declare t text;
begin
  for t in select unnest(array['settings_sync','accounts_sync','vault_items_sync','bookmarks_sync','chats_sync','chat_messages_sync']) loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
    -- 삭제 이벤트에 행 전체(id 외 열)가 실리도록
    execute format('alter table public.%I replica identity full', t);
  end loop;
end $$;
