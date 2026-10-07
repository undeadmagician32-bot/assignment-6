import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.DB_PATH || path.join(here, 'data', 'pds.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// 날짜 규칙: 마감일·기간은 서울 기준 달력 날짜 'YYYY-MM-DD'(TEXT),
//           시각은 UTC ISO-8601 'YYYY-MM-DDTHH:MM:SS.sssZ'(TEXT). 화면에서 Asia/Seoul로 바꿔 보여 준다.
// 단위 규칙: 모든 시간 길이는 정수 '분'(*_min).
db.exec(`
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

-- 계획을 고칠 때마다 한 줄씩 쌓이는 버전표. version=1 이 처음 세운 계획이며 절대 바뀌지 않는다.
CREATE TABLE IF NOT EXISTS plan_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
CREATE TRIGGER IF NOT EXISTS trg_plan_versions_no_update BEFORE UPDATE ON plan_versions
BEGIN SELECT RAISE(ABORT, 'plan_versions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_plan_versions_no_delete BEFORE DELETE ON plan_versions
BEGIN SELECT RAISE(ABORT, 'plan_versions is append-only'); END;

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  due_date TEXT,
  priority INTEGER NOT NULL CHECK (priority IN (1,2,3)),
  estimate_min INTEGER NOT NULL CHECK (estimate_min >= 0),
  status TEXT NOT NULL CHECK (status IN ('open','done')) DEFAULT 'open',
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

-- 실행 기록: 계획(todos)과 별개 표. 저장해도 todos 값은 건드리지 않는다.
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id INTEGER NOT NULL REFERENCES todos(id),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL CHECK (ended_at >= started_at),
  actual_min INTEGER NOT NULL CHECK (actual_min >= 0),
  blocked_reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_runs_todo ON runs(todo_id);

-- 완료 기록: 같은 요청 키는 한 번만(UNIQUE), 같은 할 일의 '현재 유효한' 완료는 한 건만(부분 UNIQUE).
CREATE TABLE IF NOT EXISTS completion_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id INTEGER NOT NULL REFERENCES todos(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  completed_at TEXT NOT NULL,
  reopened_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_completion_active ON completion_events(todo_id)
  WHERE reopened_at IS NULL;

CREATE TABLE IF NOT EXISTS reflections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_plan_id INTEGER REFERENCES plans(id),
  period_from TEXT,
  period_to TEXT,
  summary TEXT NOT NULL DEFAULT '',
  improvement TEXT NOT NULL CHECK (length(trim(improvement)) > 0),
  carried_plan_id INTEGER REFERENCES plans(id),
  created_at TEXT NOT NULL
);
`);

export const nowIso = () => new Date().toISOString();

export function seoulToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
