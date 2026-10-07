// DB 연결: DATABASE_URL 이 있으면 Postgres(Supabase 등), 없으면 로컬용 PGlite(진짜 Postgres 엔진, 파일 저장).
// 날짜 규칙: 마감일·기간은 서울 기준 달력 날짜 TEXT 'YYYY-MM-DD',
//           시각은 UTC ISO-8601 TEXT 'YYYY-MM-DDTHH:MM:SS.sssZ'. 화면에서 Asia/Seoul로 바꿔 보여 준다.
// 단위 규칙: 모든 시간 길이는 정수 '분'(*_min).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

let driver;
async function getDriver() {
  if (driver) return driver;
  if (process.env.DATABASE_URL) {
    const pg = (await import('pg')).default;
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: process.env.VERCEL ? 1 : 5,
      ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
    });
    driver = {
      query: (s, p) => pool.query(s, p),
      async tx(fn) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn({ query: (s, p) => c.query(s, p), exec: (s) => c.query(s) });
          await c.query('COMMIT');
          return r;
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
        finally { c.release(); }
      },
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR || path.join(here, 'data', 'pglite');
    const lite = new PGlite(dir);
    await lite.waitReady;
    driver = {
      query: (s, p) => lite.query(s, p),
      tx: (fn) => lite.transaction((t) => fn({ query: (s, p) => t.query(s, p), exec: (s) => t.exec(s) })),
    };
  }
  return driver;
}

// 모든 SQL 은 '?' 자리표시자를 쓰고 여기서 $1.. 로 바꾼다.
export async function query(sql, params = []) {
  const d = await getDriver();
  return (await d.query(toPg(sql), params)).rows;
}
export async function tx(fn) {
  const d = await getDriver();
  return d.tx((t) => fn({ query: async (sql, params = []) => (await t.query(toPg(sql), params)).rows, exec: (sql) => t.exec(sql) }));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL CHECK (period_end >= period_start),
  priority INTEGER NOT NULL CHECK (priority IN (1,2,3)),
  success_criteria TEXT NOT NULL CHECK (length(trim(success_criteria)) > 0),
  estimate_min INTEGER NOT NULL CHECK (estimate_min >= 0),
  carried_from_reflection_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_plans_carried ON plans(carried_from_reflection_id)
  WHERE carried_from_reflection_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS plan_versions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  priority INTEGER NOT NULL,
  success_criteria TEXT NOT NULL,
  estimate_min INTEGER NOT NULL,
  saved_at TEXT NOT NULL,
  UNIQUE (plan_id, version)
);
CREATE OR REPLACE FUNCTION plan_versions_append_only() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'plan_versions is append-only'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_plan_versions_no_change ON plan_versions;
CREATE TRIGGER trg_plan_versions_no_change BEFORE UPDATE OR DELETE ON plan_versions
  FOR EACH ROW EXECUTE FUNCTION plan_versions_append_only();

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  due_date TEXT,
  priority INTEGER NOT NULL CHECK (priority IN (1,2,3)),
  estimate_min INTEGER NOT NULL CHECK (estimate_min >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  completed_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_todos_plan ON todos(plan_id);

CREATE TABLE IF NOT EXISTS todo_tags (
  todo_id INTEGER NOT NULL REFERENCES todos(id),
  tag TEXT NOT NULL,
  PRIMARY KEY (todo_id, tag)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  todo_id INTEGER NOT NULL REFERENCES todos(id),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL CHECK (ended_at >= started_at),
  actual_min INTEGER NOT NULL CHECK (actual_min >= 0),
  blocked_reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_runs_todo ON runs(todo_id);

CREATE TABLE IF NOT EXISTS completion_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  todo_id INTEGER NOT NULL REFERENCES todos(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  completed_at TEXT NOT NULL,
  reopened_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_completion_active ON completion_events(todo_id)
  WHERE reopened_at IS NULL;

CREATE TABLE IF NOT EXISTS reflections (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_plan_id INTEGER REFERENCES plans(id),
  period_from TEXT,
  period_to TEXT,
  summary TEXT NOT NULL DEFAULT '',
  improvement TEXT NOT NULL CHECK (length(trim(improvement)) > 0),
  carried_plan_id INTEGER REFERENCES plans(id),
  created_at TEXT NOT NULL
);
`;

let ready;
// 서버리스에서 여러 인스턴스가 동시에 처음 뜰 수 있으므로 advisory lock 으로 스키마 생성을 직렬화한다.
export function ensureSchema() {
  ready ??= tx(async (t) => {
    await t.query('SELECT pg_advisory_xact_lock(7060606)');
    await t.exec(SCHEMA);
  }).catch((e) => { ready = undefined; throw e; });
  return ready;
}

export const nowIso = () => new Date().toISOString();
export function seoulToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
