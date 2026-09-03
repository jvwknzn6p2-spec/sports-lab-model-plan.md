-- サッカー台帳 初期スキーマ（自分名義の Supabase 用）— football-ledger 0001
--
-- VORTE EV（野球）で確立した不変条件をそのまま移す:
--   1. 予想は封緘（kickoff − 60 分）前に発行され、封緘後は変更できない
--   2. 台帳（predictions / outcomes / evaluations）は追記専用。訂正は supersede の追記
--   3. 正準モデルはレジストリ（serving_models）が唯一の権威。ビューに文字列で埋めない
--   4. 決済は 90 分（FT90）の勝ち / 引き分け / 負け。延長・PK は別の basis として残す
--   5. 欠損は埋めない。得点が無い試合は決済しない（フェイルクローズ）
--   6. ブラウザから書ける経路を作らない。書き込みは service_role（GitHub Actions）のみ
--
-- 適用: supabase db push（GitHub Actions から。手順は football-ledger/README.md）
-- 検証: SQL 構文は libpg-query で検査済み（plpgsql 本体は未検査）。実 DB での振る舞い検証は適用後に行う

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- 参照
create table if not exists competitions (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,           -- 'J1' / 'E0' / 'SP1' …（football-data の Division と同じ）
  name        text not null,
  country     text,
  created_at  timestamptz not null default now()
);

create table if not exists teams (
  id              uuid primary key default gen_random_uuid(),
  competition_id  uuid not null references competitions(id),
  name            text not null,               -- 正式名称（表示・別名解決の権威）
  aliases         text[] not null default '{}',
  created_at      timestamptz not null default now(),
  unique (competition_id, name)
);

-- ---------------------------------------------------------------- 試合
create table if not exists matches (
  id                 uuid primary key default gen_random_uuid(),
  competition_id     uuid not null references competitions(id),
  season             text not null,            -- '2026' / '2025-26'
  provider           text not null,            -- 'football-data' / 'jleague' …
  provider_match_id  text not null,
  home_team_id       uuid not null references teams(id),
  away_team_id       uuid not null references teams(id),
  kickoff_at         timestamptz not null,     -- 最初の予定。延期で前進させない（VORTE EV「締切の権威」）
  status             text not null default 'scheduled'
                     check (status in ('scheduled','in_progress','final','postponed','cancelled')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (provider, provider_match_id),
  check (home_team_id <> away_team_id)
);
create index if not exists matches_kickoff_idx on matches (kickoff_at);

-- 封緘時刻の定義は 1 箇所。kickoff の 60 分前（スタメン発表の後・キックオフ前）
create or replace function prediction_cutoff_at(p_kickoff timestamptz)
returns timestamptz language sql immutable as $$
  select p_kickoff - interval '60 minutes'
$$;

-- ---------------------------------------------------------------- モデルと正準
create table if not exists model_versions (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,            -- 'dc-v1'（Dixon-Coles・時間減衰 ξ=0.0065）
  engine      text not null,                   -- 'football-model@<git sha>'
  parameters  jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- 正準モデルのレジストリ。交代 = Founder 承認 → 1 行 INSERT（VORTE EV と同じ）
create table if not exists serving_models (
  id                uuid primary key default gen_random_uuid(),
  competition_code  text not null,             -- '*' で全大会
  model_name        text not null references model_versions(name),
  effective_from    timestamptz not null,
  approved_by       text not null,
  note              text,
  created_at        timestamptz not null default now()
);

create or replace function serving_model_name(p_competition_code text)
returns text language sql stable as $$
  select model_name
    from serving_models
   where (competition_code = p_competition_code or competition_code = '*')
     and effective_from <= now()
   order by (competition_code = p_competition_code) desc, effective_from desc
   limit 1
$$;

-- ---------------------------------------------------------------- 予想（追記専用・封緘）
create table if not exists predictions (
  id                       uuid primary key default gen_random_uuid(),
  match_id                 uuid not null references matches(id),
  model_version_id         uuid not null references model_versions(id),
  p_home                   numeric(5,4) not null,
  p_draw                   numeric(5,4) not null,
  p_away                   numeric(5,4) not null,
  lambda_home              numeric(6,3),
  lambda_away              numeric(6,3),
  as_of                    timestamptz not null,   -- 学習に使った最後のデータの時刻
  cutoff_at                timestamptz not null,   -- 封緘時刻（matches.kickoff_at から導出・検査される）
  published_at             timestamptz not null default now(),
  supersedes_prediction_id uuid references predictions(id),
  payload_fingerprint      text not null,          -- sha256(match_id|model|p_home|p_draw|p_away|cutoff)
  created_at               timestamptz not null default now(),
  check (abs(p_home + p_draw + p_away - 1) < 0.0005),
  check (p_home between 0 and 1 and p_draw between 0 and 1 and p_away between 0 and 1),
  unique (payload_fingerprint)
);
create index if not exists predictions_match_idx on predictions (match_id);

-- 封緘ガード: 封緘後の発行と、封緘時刻の詐称を拒否する
create or replace function guard_prediction_sealed()
returns trigger language plpgsql as $$
declare
  v_kickoff timestamptz;
begin
  select kickoff_at into v_kickoff from matches where id = new.match_id;
  if v_kickoff is null then
    raise exception 'AFL1: match % not found', new.match_id using errcode = 'AFL01';
  end if;
  if new.cutoff_at <> prediction_cutoff_at(v_kickoff) then
    raise exception 'AFL2: cutoff_at % does not match kickoff %', new.cutoff_at, v_kickoff using errcode = 'AFL02';
  end if;
  if new.published_at > new.cutoff_at then
    raise exception 'AFL3: prediction published after cutoff (% > %)', new.published_at, new.cutoff_at using errcode = 'AFL03';
  end if;
  return new;
end
$$;
drop trigger if exists predictions_sealed on predictions;
create trigger predictions_sealed before insert on predictions
  for each row execute function guard_prediction_sealed();

-- ---------------------------------------------------------------- 結果（追記専用）
create table if not exists outcomes (
  id                     uuid primary key default gen_random_uuid(),
  match_id               uuid not null references matches(id),
  home_goals             integer not null check (home_goals >= 0),
  away_goals             integer not null check (away_goals >= 0),
  basis                  text not null default 'FT90' check (basis in ('FT90','AET','PEN')),
  source                 text not null,
  recorded_at            timestamptz not null default now(),
  supersedes_outcome_id  uuid references outcomes(id),
  created_at             timestamptz not null default now()
);
create index if not exists outcomes_match_idx on outcomes (match_id);

-- ---------------------------------------------------------------- 決済（追記専用）
create table if not exists evaluations (
  id             uuid primary key default gen_random_uuid(),
  prediction_id  uuid not null references predictions(id),
  outcome_id     uuid not null references outcomes(id),
  result         text not null check (result in ('H','D','A')),
  rps            numeric(8,6) not null,
  brier          numeric(8,6) not null,
  logloss        numeric(8,6) not null,
  evaluated_at   timestamptz not null default now(),
  unique (prediction_id, outcome_id)
);

-- 3 値の採点（football-model/scoring.ts と同じ式）
create or replace function score_prediction(
  p_home numeric, p_draw numeric, p_away numeric, p_result text,
  out rps numeric, out brier numeric, out logloss numeric
) language plpgsql immutable as $$
declare
  o_h numeric := case when p_result = 'H' then 1 else 0 end;
  o_d numeric := case when p_result = 'D' then 1 else 0 end;
  o_a numeric := case when p_result = 'A' then 1 else 0 end;
  p_actual numeric := case p_result when 'H' then p_home when 'D' then p_draw else p_away end;
begin
  rps := (power(p_home - o_h, 2) + power(p_home + p_draw - o_h - o_d, 2)) / 2;
  brier := power(p_home - o_h, 2) + power(p_draw - o_d, 2) + power(p_away - o_a, 2);
  logloss := -ln(greatest(p_actual, 1e-12));
end
$$;

-- 試合を決済する: FT90 の最新 outcome で、非 superseded の全予想に evaluations を追記
create or replace function settle_match(p_match_id uuid)
returns integer language plpgsql as $$
declare
  v_outcome outcomes%rowtype;
  v_result text;
  v_n integer := 0;
  r record;
  s record;
begin
  select o.* into v_outcome
    from outcomes o
   where o.match_id = p_match_id and o.basis = 'FT90'
     and not exists (select 1 from outcomes o2 where o2.supersedes_outcome_id = o.id)
   order by o.recorded_at desc limit 1;
  if v_outcome.id is null then
    return 0; -- 得点が無ければ決済しない（フェイルクローズ）
  end if;
  v_result := case when v_outcome.home_goals > v_outcome.away_goals then 'H'
                   when v_outcome.home_goals = v_outcome.away_goals then 'D' else 'A' end;
  for r in
    select p.* from predictions p
     where p.match_id = p_match_id
       and not exists (select 1 from predictions nx where nx.supersedes_prediction_id = p.id)
       and not exists (select 1 from evaluations e where e.prediction_id = p.id and e.outcome_id = v_outcome.id)
  loop
    select * into s from score_prediction(r.p_home, r.p_draw, r.p_away, v_result);
    insert into evaluations (prediction_id, outcome_id, result, rps, brier, logloss)
    values (r.id, v_outcome.id, v_result, s.rps, s.brier, s.logloss);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- ---------------------------------------------------------------- 追記専用
create or replace function forbid_update_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'AFL9: % is append-only', tg_table_name using errcode = 'AFL09';
end
$$;
drop trigger if exists predictions_append_only on predictions;
create trigger predictions_append_only before update or delete on predictions
  for each row execute function forbid_update_delete();
drop trigger if exists outcomes_append_only on outcomes;
create trigger outcomes_append_only before update or delete on outcomes
  for each row execute function forbid_update_delete();
drop trigger if exists evaluations_append_only on evaluations;
create trigger evaluations_append_only before update or delete on evaluations
  for each row execute function forbid_update_delete();

-- ---------------------------------------------------------------- 配信ビュー
-- 正準モデルの予想を 1 試合 1 行で（正準 → published_at 降順。「最新」で選ばない）
create or replace view match_board with (security_invoker = true) as
select m.id as match_id, c.code as competition, m.season, m.kickoff_at, m.status,
       th.name as home_team, ta.name as away_team,
       prediction_cutoff_at(m.kickoff_at) as cutoff_at,
       p.model, p.p_home, p.p_draw, p.p_away, p.published_at,
       o.home_goals, o.away_goals
  from matches m
  join competitions c on c.id = m.competition_id
  join teams th on th.id = m.home_team_id
  join teams ta on ta.id = m.away_team_id
  left join lateral (
    select mv.name as model, pr.p_home, pr.p_draw, pr.p_away, pr.published_at
      from predictions pr join model_versions mv on mv.id = pr.model_version_id
     where pr.match_id = m.id
       and not exists (select 1 from predictions nx where nx.supersedes_prediction_id = pr.id)
     order by (mv.name = serving_model_name(c.code)) desc, pr.published_at desc
     limit 1) p on true
  left join lateral (
    select oc.home_goals, oc.away_goals from outcomes oc
     where oc.match_id = m.id and oc.basis = 'FT90'
       and not exists (select 1 from outcomes o2 where o2.supersedes_outcome_id = oc.id)
     order by oc.recorded_at desc limit 1) o on true;

-- モデル別の通算（RPS 主指標・的中は最大確率の結果）
create or replace view model_performance with (security_invoker = true) as
select c.code as competition, mv.name as model,
       count(*) as n,
       count(*) filter (where
         (e.result = 'H' and p.p_home >= p.p_draw and p.p_home >= p.p_away) or
         (e.result = 'D' and p.p_draw >  p.p_home and p.p_draw >= p.p_away) or
         (e.result = 'A' and p.p_away >  p.p_home and p.p_away >  p.p_draw)) as hits,
       round(avg(e.rps), 4) as rps,
       round(avg(e.brier), 4) as brier,
       round(avg(e.logloss), 4) as logloss
  from evaluations e
  join predictions p on p.id = e.prediction_id
  join model_versions mv on mv.id = p.model_version_id
  join matches m on m.id = p.match_id
  join competitions c on c.id = m.competition_id
 group by c.code, mv.name;

-- ---------------------------------------------------------------- 権限
-- 全テーブル RLS。anon は何も読めない。authenticated は読むだけ。書くのは service_role だけ
alter table competitions   enable row level security;
alter table teams          enable row level security;
alter table matches        enable row level security;
alter table model_versions enable row level security;
alter table serving_models enable row level security;
alter table predictions    enable row level security;
alter table outcomes       enable row level security;
alter table evaluations    enable row level security;

create policy competitions_read   on competitions   for select to authenticated using (true);
create policy teams_read          on teams          for select to authenticated using (true);
create policy matches_read        on matches        for select to authenticated using (true);
create policy model_versions_read on model_versions for select to authenticated using (true);
create policy serving_models_read on serving_models for select to authenticated using (true);
create policy predictions_read    on predictions    for select to authenticated using (true);
create policy outcomes_read       on outcomes       for select to authenticated using (true);
create policy evaluations_read    on evaluations    for select to authenticated using (true);

-- Supabase の既定権限は anon にも付くので、明示的に剥がす（VORTE EV「関数を足したら封緘し直す」）
revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon, authenticated;
revoke execute on function settle_match(uuid) from public;
