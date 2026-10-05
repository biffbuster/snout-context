/**
 * One SQL dialect everywhere: Postgres in production (DATABASE_URL), and PGlite — Postgres
 * compiled to WebAssembly — for local dev and tests, so no query is ever tested against a
 * different engine than the one it runs on.
 */
const SCHEMA = `
create table if not exists users (
  id bigserial primary key,
  github_id bigint unique,
  login text not null,
  name text,
  avatar text,
  created_at timestamptz not null default now()
);
create table if not exists teams (
  id bigserial primary key,
  name text not null,
  personal boolean not null default false,
  plan text not null default 'free',
  created_at timestamptz not null default now()
);
create table if not exists memberships (
  team_id bigint not null references teams(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create table if not exists tokens (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  team_id bigint not null references teams(id) on delete cascade,
  hash text not null unique,
  label text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create table if not exists device_codes (
  device_hash text primary key,
  user_code text not null unique,
  status text not null default 'pending',
  user_id bigint references users(id) on delete cascade,
  team_id bigint references teams(id) on delete cascade,
  expires_at timestamptz not null
);
create table if not exists projects (
  id bigserial primary key,
  team_id bigint not null references teams(id) on delete cascade,
  key text not null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (team_id, key)
);
create table if not exists usage_daily (
  team_id bigint not null references teams(id) on delete cascade,
  project_id bigint not null references projects(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  day date not null,
  client text not null,
  label text not null,
  reads integer not null,
  gated integer not null,
  in_context bigint not null,
  held_back bigint not null,
  could_hold_back bigint not null,
  updated_at timestamptz not null default now(),
  primary key (team_id, project_id, user_id, day, client, label)
);
create index if not exists usage_daily_team_day on usage_daily (team_id, day);
create table if not exists spend_daily (
  team_id bigint not null references teams(id) on delete cascade,
  project_id bigint not null references projects(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  day date not null,
  client text not null,
  model text not null,
  requests integer not null,
  input bigint not null,
  cache_write bigint not null,
  cache_read bigint not null,
  output bigint not null,
  cost_usd double precision,
  updated_at timestamptz not null default now(),
  primary key (team_id, project_id, user_id, day, client, model)
);
create index if not exists spend_daily_team_day on spend_daily (team_id, day);
create table if not exists beta_codes (
  code_hash text primary key,
  hint text not null,
  note text not null default '',
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_by bigint references users(id) on delete set null,
  redeemed_at timestamptz
);
create table if not exists agent_runs (
  team_id bigint not null references teams(id) on delete cascade,
  token_id bigint not null references tokens(id) on delete cascade,
  run_hash text not null,
  day date not null default ((now() at time zone 'utc')::date),
  primary key (team_id, run_hash)
);
create index if not exists agent_runs_team_day on agent_runs (team_id, day);
create table if not exists invites (
  token_hash text primary key,
  team_id bigint not null references teams(id) on delete cascade,
  created_by bigint not null references users(id) on delete cascade,
  expires_at timestamptz not null
);
-- Columns added after launch: after every create, so a fresh database gets them too.
alter table users add column if not exists approved_at timestamptz;
alter table teams add column if not exists stripe_customer_id text;
alter table teams add column if not exists stripe_subscription_id text;
alter table teams add column if not exists seats integer;
alter table teams add column if not exists billing_status text;
alter table teams add column if not exists current_period_end timestamptz;
alter table tokens add column if not exists kind text not null default 'cli';
alter table tokens add column if not exists created_by bigint;
alter table users add column if not exists is_agent boolean not null default false;
alter table agent_runs alter column day set default ((now() at time zone 'utc')::date);
alter table usage_daily add column if not exists model text not null default '';
`;

/**
 * Statements that can't be split on ";" (they contain their own), run whole, in order, on
 * every start; each checks before it changes anything.
 */
const MIGRATIONS = [
  // Savings split by model: the model joins the daily key, so one day can hold a row per model.
  `do $$ begin
     if not exists (select 1 from information_schema.key_column_usage where table_name = 'usage_daily' and constraint_name = 'usage_daily_pkey' and column_name = 'model') then
       alter table usage_daily drop constraint usage_daily_pkey;
       alter table usage_daily add primary key (team_id, project_id, user_id, day, client, label, model);
     end if;
   end $$`,
];

export async function openDb(url = process.env.DATABASE_URL) {
  let query, tx, close;
  if (url) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: Number(process.env.PG_POOL || 10) });
    query = async (sql, params = []) => (await pool.query(sql, params)).rows;
    tx = async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn(async (sql, params = []) => (await client.query(sql, params)).rows);
        await client.query("commit");
        return out;
      } catch (err) {
        await client.query("rollback").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    };
    close = () => pool.end();
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite(process.env.PGLITE_DIR || undefined);
    query = async (sql, params = []) => (await db.query(sql, params)).rows;
    tx = (fn) => db.transaction((t) => fn(async (sql, params = []) => (await t.query(sql, params)).rows));
    close = () => db.close();
  }
  for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await query(stmt);
  for (const stmt of MIGRATIONS) await query(stmt);
  return { query, tx, close, engine: url ? "postgres" : "pglite" };
}
