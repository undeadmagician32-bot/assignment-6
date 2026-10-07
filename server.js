import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, tx, nowIso, seoulToday } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const PORT = Number(process.env.PORT || 3000);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

// ---------- 검증 ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function reqDate(v, name, optional = false) {
  if ((v === undefined || v === null || v === '') && optional) return null;
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z')) ||
      new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) throw bad(`${name}: YYYY-MM-DD 형식의 날짜가 필요합니다`);
  return v;
}
function reqText(v, name, max = 300) {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${name}: 비어 있을 수 없습니다`);
  if (v.length > max) throw bad(`${name}: ${max}자 이하여야 합니다`);
  return v.trim();
}
function optText(v, max = 500) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw bad('문자열이어야 합니다');
  if (v.length > max) throw bad(`${max}자 이하여야 합니다`);
  return v.trim();
}
function reqInt(v, name, min, max) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name}: ${min}~${max} 사이 정수여야 합니다`);
  return n;
}
function reqIso(v, name) {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw bad(`${name}: 시각 형식이 올바르지 않습니다`);
  return new Date(v).toISOString();
}
function parseTags(v) {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out = [...new Set(arr.map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean))];
  if (out.length > 10 || out.some((t) => t.length > 30)) throw bad('태그는 10개·각 30자 이하');
  return out;
}

// ---------- 조회 도우미 ----------
const num = (v) => (v === null || v === undefined ? 0 : Number(v));

const overdueSql = 't.status <> \'done\' AND t.due_date IS NOT NULL AND t.due_date < ?';
const blockedSql = "EXISTS (SELECT 1 FROM runs r WHERE r.todo_id = t.id AND length(trim(r.blocked_reason)) > 0)";

// 할 일 목록과 돌아보기 집계가 같은 조건을 쓰도록 한 곳에서 만든다.
function todoWhere(q, today) {
  const w = ['t.deleted_at IS NULL'];
  const a = [];
  if (q.plan_id) { w.push('t.plan_id = ?'); a.push(reqInt(q.plan_id, 'plan_id', 1, 1e9)); }
  if (q.from || q.to) {
    const from = reqDate(q.from || '0001-01-01', 'from');
    const to = reqDate(q.to || '9999-12-31', 'to');
    w.push('t.plan_id IN (SELECT id FROM plans WHERE period_start <= ? AND period_end >= ?)');
    a.push(to, from);
  }
  if (q.q) {
    w.push("(t.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM todo_tags g WHERE g.todo_id = t.id AND g.tag LIKE ? ESCAPE '\\'))");
    const like = '%' + String(q.q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    a.push(like, like);
  }
  if (q.status === 'open' || q.status === 'done') { w.push('t.status = ?'); a.push(q.status); }
  if (q.priority) { w.push('t.priority = ?'); a.push(reqInt(q.priority, 'priority', 1, 3)); }
  if (q.tag) { w.push('EXISTS (SELECT 1 FROM todo_tags g WHERE g.todo_id = t.id AND g.tag = ?)'); a.push(String(q.tag)); }
  if (q.overdue === '1') { w.push(overdueSql); a.push(today); }
  if (q.blocked === '1') w.push(blockedSql);
  return { sql: w.join(' AND '), args: a };
}

export const SORTS = {
  due: { label: '마감일 빠른 순 → 우선순위 높은 순 → 등록 번호 작은 순 (마감일 없음은 맨 뒤)',
    sql: 't.due_date IS NULL, t.due_date ASC, t.priority ASC, t.id ASC' },
  priority: { label: '우선순위 높은 순 → 마감일 빠른 순 → 등록 번호 작은 순',
    sql: 't.priority ASC, t.due_date IS NULL, t.due_date ASC, t.id ASC' },
  estimate: { label: '예상 시간 긴 순 → 등록 번호 작은 순', sql: 't.estimate_min DESC, t.id ASC' },
  newest: { label: '최근 등록 순 → 등록 번호 큰 순', sql: 't.created_at DESC, t.id DESC' },
};

function hydrateTodos(rows, today) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const tags = db.prepare(`SELECT todo_id, tag FROM todo_tags WHERE todo_id IN (${ph}) ORDER BY tag`).all(...ids);
  const runs = db.prepare(`SELECT todo_id, COUNT(*) n, SUM(actual_min) m,
      SUM(length(trim(blocked_reason)) > 0) b FROM runs WHERE todo_id IN (${ph}) GROUP BY todo_id`).all(...ids);
  const comps = db.prepare(`SELECT todo_id, COUNT(*) n FROM completion_events
      WHERE todo_id IN (${ph}) AND reopened_at IS NULL GROUP BY todo_id`).all(...ids);
  return rows.map((r) => {
    const run = runs.find((x) => x.todo_id === r.id);
    return {
      ...r,
      tags: tags.filter((t) => t.todo_id === r.id).map((t) => t.tag),
      run_count: num(run?.n),
      actual_min: num(run?.m),
      blocked: num(run?.b) > 0,
      overdue: r.status !== 'done' && !!r.due_date && r.due_date < today,
      active_completions: num(comps.find((x) => x.todo_id === r.id)?.n),
    };
  });
}

function getTodo(id) {
  const today = seoulToday();
  const row = db.prepare(`SELECT t.*, p.title AS plan_title FROM todos t JOIN plans p ON p.id = t.plan_id
    WHERE t.id = ? AND t.deleted_at IS NULL`).get(id);
  if (!row) throw new HttpError(404, '할 일을 찾을 수 없습니다');
  return hydrateTodos([row], today)[0];
}

function listTodos(q) {
  const today = seoulToday();
  const sortKey = SORTS[q.sort] ? q.sort : 'due';
  const { sql, args } = todoWhere(q, today);
  const rows = db.prepare(`SELECT t.*, p.title AS plan_title FROM todos t JOIN plans p ON p.id = t.plan_id
    WHERE ${sql} ORDER BY ${SORTS[sortKey].sql}`).all(...args);
  return { today, sort: sortKey, sort_label: SORTS[sortKey].label, todos: hydrateTodos(rows, today) };
}

function getPlan(id) {
  const p = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  if (!p) throw new HttpError(404, '계획을 찾을 수 없습니다');
  return p;
}

function planFields(b, cur = {}) {
  const f = {
    title: reqText(b.title ?? cur.title, '계획 이름', 120),
    period_start: reqDate(b.period_start ?? cur.period_start, '시작일'),
    period_end: reqDate(b.period_end ?? cur.period_end, '종료일'),
    priority: reqInt(b.priority ?? cur.priority, '우선순위', 1, 3),
    success_criteria: reqText(b.success_criteria ?? cur.success_criteria, '성공 기준', 500),
    estimate_min: reqInt(b.estimate_min ?? cur.estimate_min, '예상 시간(분)', 0, 100000),
  };
  if (f.period_end < f.period_start) throw bad('종료일이 시작일보다 빠릅니다');
  return f;
}

function insertPlan(f, extra = {}) {
  const t = nowIso();
  const r = db.prepare(`INSERT INTO plans (title, period_start, period_end, priority, success_criteria, estimate_min,
      carried_from_reflection_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(f.title, f.period_start, f.period_end, f.priority, f.success_criteria, f.estimate_min,
      extra.reflection_id ?? null, t, t);
  const id = Number(r.lastInsertRowid);
  snapshotPlan(id, 1, f, t);
  return id;
}

function snapshotPlan(id, version, f, t) {
  db.prepare(`INSERT INTO plan_versions (plan_id, version, title, period_start, period_end, priority,
      success_criteria, estimate_min, saved_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, version, f.title, f.period_start, f.period_end, f.priority, f.success_criteria, f.estimate_min, t);
}

function insertTodo(planId, b) {
  getPlan(planId);
  const t = nowIso();
  const f = {
    title: reqText(b.title, '할 일 제목', 200),
    due_date: reqDate(b.due_date, '마감일', true),
    priority: reqInt(b.priority ?? 2, '우선순위', 1, 3),
    estimate_min: reqInt(b.estimate_min ?? 0, '예상 시간(분)', 0, 100000),
  };
  const tags = parseTags(b.tags);
  const r = db.prepare(`INSERT INTO todos (plan_id, title, due_date, priority, estimate_min, status, created_at, updated_at)
    VALUES (?,?,?,?,?, 'open', ?, ?)`).run(planId, f.title, f.due_date, f.priority, f.estimate_min, t, t);
  const id = Number(r.lastInsertRowid);
  setTags(id, tags);
  return id;
}

function setTags(todoId, tags) {
  db.prepare('DELETE FROM todo_tags WHERE todo_id = ?').run(todoId);
  const ins = db.prepare('INSERT INTO todo_tags (todo_id, tag) VALUES (?,?)');
  for (const t of tags) ins.run(todoId, t);
}

// ---------- 집계 ----------
function review(q) {
  const today = seoulToday();
  const { sql, args } = todoWhere({ plan_id: q.plan_id, from: q.from, to: q.to }, today);
  const sums = db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(t.status = 'done'), 0) AS done,
      COALESCE(SUM(${overdueSql}), 0) AS overdue,
      COALESCE(SUM(${blockedSql}), 0) AS blocked,
      COALESCE(SUM(t.estimate_min), 0) AS expected
    FROM todos t WHERE ${sql}`).get(today, ...args);
  const actual = db.prepare(`SELECT COALESCE(SUM(r.actual_min), 0) AS m FROM runs r
    JOIN todos t ON t.id = r.todo_id WHERE ${sql}`).get(...args).m;
  const planRows = db.prepare(`SELECT id, title, period_start, period_end FROM plans
    WHERE (? IS NULL OR id = ?) AND period_start <= ? AND period_end >= ? ORDER BY period_start, id`)
    .all(q.plan_id ? Number(q.plan_id) : null, q.plan_id ? Number(q.plan_id) : null,
      q.to ? reqDate(q.to, 'to') : '9999-12-31', q.from ? reqDate(q.from, 'from') : '0001-01-01');
  return {
    today, timezone: 'Asia/Seoul', unit: 'minutes',
    scope: { plan_id: q.plan_id ? Number(q.plan_id) : null, from: q.from || null, to: q.to || null },
    plans_in_scope: planRows,
    // 계획 수 = 대상 계획에 딸린 지우지 않은 할 일 수
    planned: num(sums.total), done: num(sums.done), overdue: num(sums.overdue), blocked: num(sums.blocked),
    expected_min: num(sums.expected), actual_min: num(actual), diff_min: num(actual) - num(sums.expected),
  };
}

// ---------- 라우터 ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('GET', '/api/health', () => ({ ok: true, today_seoul: seoulToday() }));

route('GET', '/api/plans', () => {
  const rows = db.prepare(`SELECT p.*,
      (SELECT COUNT(*) FROM todos t WHERE t.plan_id = p.id AND t.deleted_at IS NULL) AS todo_count,
      (SELECT COUNT(*) FROM todos t WHERE t.plan_id = p.id AND t.deleted_at IS NULL AND t.status = 'done') AS done_count,
      (SELECT COUNT(*) FROM plan_versions v WHERE v.plan_id = p.id) AS version_count
    FROM plans p ORDER BY p.period_start DESC, p.id DESC`).all();
  return { plans: rows };
});
route('POST', '/api/plans', ({ body }) => {
  const f = planFields(body);
  const id = tx(() => insertPlan(f));
  return { plan: getPlan(id) };
});
route('PATCH', '/api/plans/:id', ({ params, body }) => {
  const id = Number(params.id);
  return tx(() => {
    const cur = getPlan(id);
    const f = planFields(body, cur);
    const same = Object.keys(f).every((k) => f[k] === cur[k]);
    if (!same) {
      const t = nowIso();
      const ver = db.prepare('SELECT MAX(version) v FROM plan_versions WHERE plan_id = ?').get(id).v + 1;
      db.prepare(`UPDATE plans SET title=?, period_start=?, period_end=?, priority=?, success_criteria=?, estimate_min=?,
        updated_at=? WHERE id=?`).run(f.title, f.period_start, f.period_end, f.priority, f.success_criteria, f.estimate_min, t, id);
      snapshotPlan(id, ver, f, t);
    }
    return { plan: getPlan(id) };
  });
});
route('GET', '/api/plans/:id/versions', ({ params }) => {
  const id = Number(params.id);
  getPlan(id);
  return { versions: db.prepare('SELECT * FROM plan_versions WHERE plan_id = ? ORDER BY version').all(id) };
});

route('GET', '/api/todos', ({ query }) => listTodos(query));
route('GET', '/api/todos/:id', ({ params }) => {
  const todo = getTodo(Number(params.id));
  const runs = db.prepare('SELECT * FROM runs WHERE todo_id = ? ORDER BY started_at, id').all(todo.id);
  const completions = db.prepare('SELECT * FROM completion_events WHERE todo_id = ? ORDER BY id').all(todo.id);
  return { todo, runs, completions };
});
route('POST', '/api/plans/:id/todos', ({ params, body }) => {
  const id = tx(() => insertTodo(Number(params.id), body));
  return { todo: getTodo(id) };
});
route('PATCH', '/api/todos/:id', ({ params, body }) => {
  const id = Number(params.id);
  return tx(() => {
    const cur = getTodo(id);
    const t = nowIso();
    const f = {
      title: reqText(body.title ?? cur.title, '할 일 제목', 200),
      due_date: 'due_date' in body ? reqDate(body.due_date, '마감일', true) : cur.due_date,
      priority: reqInt(body.priority ?? cur.priority, '우선순위', 1, 3),
      estimate_min: reqInt(body.estimate_min ?? cur.estimate_min, '예상 시간(분)', 0, 100000),
    };
    db.prepare('UPDATE todos SET title=?, due_date=?, priority=?, estimate_min=?, updated_at=? WHERE id=?')
      .run(f.title, f.due_date, f.priority, f.estimate_min, t, id);
    if ('tags' in body) setTags(id, parseTags(body.tags));
    return { todo: getTodo(id) };
  });
});
route('DELETE', '/api/todos/:id', ({ params }) => {
  const id = Number(params.id);
  return tx(() => {
    getTodo(id);
    db.prepare('UPDATE todos SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), id);
    return { deleted: true, id };
  });
});

route('POST', '/api/todos/:id/complete', ({ params, headers }) => {
  const id = Number(params.id);
  const key = String(headers['idempotency-key'] || '').slice(0, 100) || crypto.randomUUID();
  return tx(() => {
    const cur = getTodo(id);
    // 같은 키로 이미 처리된 요청이면 결과만 돌려준다.
    const seen = db.prepare('SELECT todo_id FROM completion_events WHERE idempotency_key = ?').get(key);
    if (seen && seen.todo_id !== id) throw new HttpError(409, '이 요청 키는 다른 할 일에 이미 사용되었습니다');
    if (seen) return { todo: cur, duplicate: true };
    if (cur.status === 'done') return { todo: cur, duplicate: true };
    const t = nowIso();
    // 부분 UNIQUE 인덱스가 마지막 방어선: 동시 요청이어도 활성 완료 기록은 1건.
    const r = db.prepare('INSERT OR IGNORE INTO completion_events (todo_id, idempotency_key, completed_at) VALUES (?,?,?)').run(id, key, t);
    if (r.changes === 0) return { todo: getTodo(id), duplicate: true };
    db.prepare("UPDATE todos SET status='done', completed_at=?, updated_at=? WHERE id=?").run(t, t, id);
    return { todo: getTodo(id), duplicate: false };
  });
});
route('POST', '/api/todos/:id/reopen', ({ params }) => {
  const id = Number(params.id);
  return tx(() => {
    const cur = getTodo(id);
    if (cur.status === 'open') return { todo: cur, duplicate: true };
    const t = nowIso();
    db.prepare('UPDATE completion_events SET reopened_at = ? WHERE todo_id = ? AND reopened_at IS NULL').run(t, id);
    db.prepare("UPDATE todos SET status='open', completed_at=NULL, updated_at=? WHERE id=?").run(t, id);
    return { todo: getTodo(id), duplicate: false };
  });
});

route('POST', '/api/todos/:id/runs', ({ params, body, headers }) => {
  const id = Number(params.id);
  return tx(() => {
    getTodo(id);
    const started = reqIso(body.started_at, '시작 시각');
    const ended = reqIso(body.ended_at, '끝난 시각');
    if (ended < started) throw bad('끝난 시각이 시작 시각보다 빠릅니다');
    const diff = Math.round((Date.parse(ended) - Date.parse(started)) / 60000);
    const actual = body.actual_min === undefined || body.actual_min === '' || body.actual_min === null
      ? diff : reqInt(body.actual_min, '실제 걸린 시간(분)', 0, 100000);
    const key = String(headers['idempotency-key'] || '').slice(0, 100) || null;
    if (key) {
      const dup = db.prepare('SELECT * FROM runs WHERE idempotency_key = ?').get(key);
      if (dup && dup.todo_id !== id) throw new HttpError(409, '이 요청 키는 다른 할 일에 이미 사용되었습니다');
      if (dup) return { run: dup, duplicate: true };
    }
    const r = db.prepare(`INSERT INTO runs (todo_id, started_at, ended_at, actual_min, blocked_reason, idempotency_key, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(id, started, ended, actual, optText(body.blocked_reason, 500), key, nowIso());
    return { run: db.prepare('SELECT * FROM runs WHERE id = ?').get(Number(r.lastInsertRowid)), duplicate: false };
  });
});
route('GET', '/api/runs', ({ query }) => {
  const { sql, args } = todoWhere({ plan_id: query.plan_id, from: query.from, to: query.to }, seoulToday());
  return { runs: db.prepare(`SELECT r.*, t.title AS todo_title, t.plan_id FROM runs r JOIN todos t ON t.id = r.todo_id
    WHERE ${sql} ORDER BY r.started_at DESC, r.id DESC`).all(...args) };
});

route('GET', '/api/review', ({ query }) => review(query));

route('GET', '/api/reflections', () => ({
  reflections: db.prepare(`SELECT f.*, p.title AS carried_plan_title FROM reflections f
    LEFT JOIN plans p ON p.id = f.carried_plan_id ORDER BY f.id DESC`).all(),
}));
route('POST', '/api/reflections', ({ body }) => {
  const r = db.prepare(`INSERT INTO reflections (scope_plan_id, period_from, period_to, summary, improvement, created_at)
    VALUES (?,?,?,?,?,?)`).run(
    body.scope_plan_id ? reqInt(body.scope_plan_id, 'scope_plan_id', 1, 1e9) : null,
    reqDate(body.period_from, 'from', true), reqDate(body.period_to, 'to', true),
    optText(body.summary, 1000), reqText(body.improvement, '고칠 점', 200), nowIso());
  return { reflection: db.prepare('SELECT * FROM reflections WHERE id = ?').get(Number(r.lastInsertRowid)) };
});
// 고칠 점 한 건 → 다음 계획(새 계획 + 첫 할 일)
route('POST', '/api/reflections/:id/carry', ({ params, body }) => {
  const id = Number(params.id);
  return tx(() => {
    const ref = db.prepare('SELECT * FROM reflections WHERE id = ?').get(id);
    if (!ref) throw new HttpError(404, '돌아보기를 찾을 수 없습니다');
    if (ref.carried_plan_id) return { plan: getPlan(ref.carried_plan_id), duplicate: true };
    const f = planFields({
      title: body.title || `다음 계획 — ${ref.improvement}`.slice(0, 120),
      period_start: body.period_start, period_end: body.period_end,
      priority: body.priority ?? 1,
      success_criteria: body.success_criteria || `이전 돌아보기에서 정한 고칠 점을 지킨다: ${ref.improvement}`,
      estimate_min: body.estimate_min ?? 60,
    });
    const planId = insertPlan(f, { reflection_id: id });
    insertTodo(planId, { title: ref.improvement.slice(0, 200), due_date: f.period_end, priority: 1, estimate_min: f.estimate_min, tags: 'carried' });
    db.prepare('UPDATE reflections SET carried_plan_id = ? WHERE id = ?').run(planId, id);
    return { plan: getPlan(planId), duplicate: false };
  });
});

route('GET', '/api/export', () => ({
  exported_at: nowIso(), timezone: 'Asia/Seoul', schema: 'pds-schema-v2',
  notes: '날짜는 YYYY-MM-DD(서울 달력 날짜), 시각은 UTC ISO-8601, 시간 길이는 분(min).',
  plans: db.prepare('SELECT * FROM plans ORDER BY id').all(),
  plan_versions: db.prepare('SELECT * FROM plan_versions ORDER BY plan_id, version').all(),
  todos: db.prepare('SELECT * FROM todos ORDER BY id').all(),
  todo_tags: db.prepare('SELECT * FROM todo_tags ORDER BY todo_id, tag').all(),
  runs: db.prepare('SELECT * FROM runs ORDER BY id').all(),
  completion_events: db.prepare('SELECT * FROM completion_events ORDER BY id').all(),
  reflections: db.prepare('SELECT * FROM reflections ORDER BY id').all(),
}));

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const SEC = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SEC, ...headers });
  res.end(body);
}
function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 100_000) { reject(new HttpError(413, '요청이 너무 큽니다')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
      catch { reject(bad('JSON 형식이 올바르지 않습니다')); }
    });
    req.on('error', reject);
  });
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
        const out = r.handler({ params: m.groups || {}, query: Object.fromEntries(url.searchParams), body, headers: req.headers });
        if (url.pathname === '/api/export') {
          return sendJson(res, 200, out, { 'Content-Disposition': 'attachment; filename="plando-diary-export.json"' });
        }
        return sendJson(res, 200, out);
      }
      return sendJson(res, 404, { error: '없는 주소입니다' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' }); }
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    const msg = String(e?.message || e);
    if (/constraint/i.test(msg)) return sendJson(res, 409, { error: '저장 규칙에 맞지 않는 값입니다' });
    console.error(e);
    return sendJson(res, 500, { error: '서버 오류가 났습니다' });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, '0.0.0.0', () => console.log(`plando-diary listening on :${PORT}`));
}
