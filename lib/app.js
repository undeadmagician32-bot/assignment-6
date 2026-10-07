// API 로직. 로컬 서버(server.js)와 Vercel 함수(api/index.js)가 같이 쓴다.
import crypto from 'node:crypto';
import { query, tx, ensureSchema, nowIso, seoulToday } from '../db.js';

export class HttpError extends Error {
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

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const one = (rows) => rows[0];

// ---------- 공통 조건 (할 일 목록과 돌아보기 집계가 같은 조건을 쓴다) ----------
const overdueSql = "t.status <> 'done' AND t.due_date IS NOT NULL AND t.due_date < ?";
const blockedSql = "EXISTS (SELECT 1 FROM runs r WHERE r.todo_id = t.id AND length(trim(r.blocked_reason)) > 0)";

function todoWhere(q, today) {
  const w = ['t.deleted_at IS NULL'];
  const a = [];
  if (q.plan_id) { w.push('t.plan_id = ?'); a.push(reqInt(q.plan_id, 'plan_id', 1, 2e9)); }
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

async function hydrateTodos(q, rows, today) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const tags = await q(`SELECT todo_id, tag FROM todo_tags WHERE todo_id IN (${ph}) ORDER BY tag`, ids);
  const runs = await q(`SELECT todo_id, COUNT(*) AS n, SUM(actual_min) AS m,
      SUM(CASE WHEN length(trim(blocked_reason)) > 0 THEN 1 ELSE 0 END) AS b FROM runs WHERE todo_id IN (${ph}) GROUP BY todo_id`, ids);
  const comps = await q(`SELECT todo_id, COUNT(*) AS n FROM completion_events
      WHERE todo_id IN (${ph}) AND reopened_at IS NULL GROUP BY todo_id`, ids);
  return rows.map((r) => {
    const run = runs.find((x) => x.todo_id === r.id);
    return {
      ...r,
      tags: tags.filter((t) => t.todo_id === r.id).map((t) => t.tag),
      run_count: num(run?.n), actual_min: num(run?.m), blocked: num(run?.b) > 0,
      overdue: r.status !== 'done' && !!r.due_date && r.due_date < today,
      active_completions: num(comps.find((x) => x.todo_id === r.id)?.n),
    };
  });
}

async function getTodo(q, id) {
  const today = seoulToday();
  const row = one(await q(`SELECT t.*, p.title AS plan_title FROM todos t JOIN plans p ON p.id = t.plan_id
    WHERE t.id = ? AND t.deleted_at IS NULL`, [id]));
  if (!row) throw new HttpError(404, '할 일을 찾을 수 없습니다');
  return (await hydrateTodos(q, [row], today))[0];
}

async function listTodos(q, filters) {
  const today = seoulToday();
  const sortKey = SORTS[filters.sort] ? filters.sort : 'due';
  const { sql, args } = todoWhere(filters, today);
  const rows = await q(`SELECT t.*, p.title AS plan_title FROM todos t JOIN plans p ON p.id = t.plan_id
    WHERE ${sql} ORDER BY ${SORTS[sortKey].sql}`, args);
  return { today, sort: sortKey, sort_label: SORTS[sortKey].label, todos: await hydrateTodos(q, rows, today) };
}

async function getPlan(q, id, lock = false) {
  const p = one(await q(`SELECT * FROM plans WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id]));
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

async function snapshotPlan(q, id, version, f, t) {
  await q(`INSERT INTO plan_versions (plan_id, version, title, period_start, period_end, priority,
      success_criteria, estimate_min, saved_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  [id, version, f.title, f.period_start, f.period_end, f.priority, f.success_criteria, f.estimate_min, t]);
}

async function insertPlan(q, f, reflectionId = null) {
  const t = nowIso();
  const id = one(await q(`INSERT INTO plans (title, period_start, period_end, priority, success_criteria, estimate_min,
      carried_from_reflection_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
  [f.title, f.period_start, f.period_end, f.priority, f.success_criteria, f.estimate_min, reflectionId, t, t])).id;
  await snapshotPlan(q, id, 1, f, t);
  return id;
}

async function setTags(q, todoId, tags) {
  await q('DELETE FROM todo_tags WHERE todo_id = ?', [todoId]);
  for (const tag of tags) await q('INSERT INTO todo_tags (todo_id, tag) VALUES (?,?)', [todoId, tag]);
}

async function insertTodo(q, planId, b) {
  await getPlan(q, planId);
  const t = nowIso();
  const f = {
    title: reqText(b.title, '할 일 제목', 200),
    due_date: reqDate(b.due_date, '마감일', true),
    priority: reqInt(b.priority ?? 2, '우선순위', 1, 3),
    estimate_min: reqInt(b.estimate_min ?? 0, '예상 시간(분)', 0, 100000),
  };
  const tags = parseTags(b.tags);
  const id = one(await q(`INSERT INTO todos (plan_id, title, due_date, priority, estimate_min, status, created_at, updated_at)
    VALUES (?,?,?,?,?, 'open', ?, ?) RETURNING id`, [planId, f.title, f.due_date, f.priority, f.estimate_min, t, t])).id;
  await setTags(q, id, tags);
  return id;
}

// ---------- 집계 ----------
async function review(q, p) {
  const today = seoulToday();
  const { sql, args } = todoWhere({ plan_id: p.plan_id, from: p.from, to: p.to }, today);
  const sums = one(await q(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0) AS done,
      COALESCE(SUM(CASE WHEN ${overdueSql} THEN 1 ELSE 0 END), 0) AS overdue,
      COALESCE(SUM(CASE WHEN ${blockedSql} THEN 1 ELSE 0 END), 0) AS blocked,
      COALESCE(SUM(t.estimate_min), 0) AS expected
    FROM todos t WHERE ${sql}`, [today, ...args]));
  const actual = one(await q(`SELECT COALESCE(SUM(r.actual_min), 0) AS m FROM runs r
    JOIN todos t ON t.id = r.todo_id WHERE ${sql}`, args)).m;
  const pw = ['period_start <= ?', 'period_end >= ?'];
  const pa = [p.to ? reqDate(p.to, 'to') : '9999-12-31', p.from ? reqDate(p.from, 'from') : '0001-01-01'];
  if (p.plan_id) { pw.push('id = ?'); pa.push(reqInt(p.plan_id, 'plan_id', 1, 2e9)); }
  const planRows = await q(`SELECT id, title, period_start, period_end FROM plans WHERE ${pw.join(' AND ')} ORDER BY period_start, id`, pa);
  return {
    today, timezone: 'Asia/Seoul', unit: 'minutes',
    scope: { plan_id: p.plan_id ? Number(p.plan_id) : null, from: p.from || null, to: p.to || null },
    plans_in_scope: planRows,
    // 계획 수 = 대상 계획에 딸린 지우지 않은 할 일 수
    planned: num(sums.total), done: num(sums.done), overdue: num(sums.overdue), blocked: num(sums.blocked),
    expected_min: num(sums.expected), actual_min: num(actual), diff_min: num(actual) - num(sums.expected),
  };
}

// ---------- 라우터 ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });
const idOf = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 2e9) throw new HttpError(404, '없는 주소입니다'); return n; };

route('GET', '/api/health', async () => { await ensureSchema(); return { ok: true, today_seoul: seoulToday() }; });

route('GET', '/api/plans', async () => ({
  plans: (await query(`SELECT p.*,
      (SELECT COUNT(*) FROM todos t WHERE t.plan_id = p.id AND t.deleted_at IS NULL)::int AS todo_count,
      (SELECT COUNT(*) FROM todos t WHERE t.plan_id = p.id AND t.deleted_at IS NULL AND t.status = 'done')::int AS done_count,
      (SELECT COUNT(*) FROM plan_versions v WHERE v.plan_id = p.id)::int AS version_count
    FROM plans p ORDER BY p.period_start DESC, p.id DESC`)),
}));
route('POST', '/api/plans', async ({ body }) => {
  const f = planFields(body);
  return tx(async (t) => ({ plan: await getPlan(t.query, await insertPlan(t.query, f)) }));
});
route('PATCH', '/api/plans/:id', async ({ params, body }) => {
  const id = idOf(params.id);
  return tx(async ({ query: q }) => {
    const cur = await getPlan(q, id, true);
    const f = planFields(body, cur);
    if (!Object.keys(f).every((k) => f[k] === cur[k])) {
      const t = nowIso();
      const ver = one(await q('SELECT MAX(version) AS v FROM plan_versions WHERE plan_id = ?', [id])).v + 1;
      await q(`UPDATE plans SET title=?, period_start=?, period_end=?, priority=?, success_criteria=?, estimate_min=?,
        updated_at=? WHERE id=?`, [f.title, f.period_start, f.period_end, f.priority, f.success_criteria, f.estimate_min, t, id]);
      await snapshotPlan(q, id, ver, f, t);
    }
    return { plan: await getPlan(q, id) };
  });
});
route('GET', '/api/plans/:id/versions', async ({ params }) => {
  const id = idOf(params.id);
  await getPlan(query, id);
  return { versions: await query('SELECT * FROM plan_versions WHERE plan_id = ? ORDER BY version', [id]) };
});

route('GET', '/api/todos', ({ query: f }) => listTodos(query, f));
route('GET', '/api/todos/:id', async ({ params }) => {
  const todo = await getTodo(query, idOf(params.id));
  return {
    todo,
    runs: await query('SELECT * FROM runs WHERE todo_id = ? ORDER BY started_at, id', [todo.id]),
    completions: await query('SELECT * FROM completion_events WHERE todo_id = ? ORDER BY id', [todo.id]),
  };
});
route('POST', '/api/plans/:id/todos', async ({ params, body }) => {
  const pid = idOf(params.id);
  return tx(async ({ query: q }) => ({ todo: await getTodo(q, await insertTodo(q, pid, body)) }));
});
route('PATCH', '/api/todos/:id', async ({ params, body }) => {
  const id = idOf(params.id);
  return tx(async ({ query: q }) => {
    const cur = await getTodo(q, id);
    const f = {
      title: reqText(body.title ?? cur.title, '할 일 제목', 200),
      due_date: 'due_date' in body ? reqDate(body.due_date, '마감일', true) : cur.due_date,
      priority: reqInt(body.priority ?? cur.priority, '우선순위', 1, 3),
      estimate_min: reqInt(body.estimate_min ?? cur.estimate_min, '예상 시간(분)', 0, 100000),
    };
    await q('UPDATE todos SET title=?, due_date=?, priority=?, estimate_min=?, updated_at=? WHERE id=?',
      [f.title, f.due_date, f.priority, f.estimate_min, nowIso(), id]);
    if ('tags' in body) await setTags(q, id, parseTags(body.tags));
    return { todo: await getTodo(q, id) };
  });
});
route('DELETE', '/api/todos/:id', async ({ params }) => {
  const id = idOf(params.id);
  return tx(async ({ query: q }) => {
    await getTodo(q, id);
    const t = nowIso();
    await q('UPDATE todos SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, id]);
    return { deleted: true, id };
  });
});

route('POST', '/api/todos/:id/complete', async ({ params, headers }) => {
  const id = idOf(params.id);
  const key = String(headers['idempotency-key'] || '').slice(0, 100) || crypto.randomUUID();
  return tx(async ({ query: q }) => {
    // 같은 할 일 행을 잠가 동시에 들어온 완료 요청을 한 줄로 세운다.
    await q('SELECT id FROM todos WHERE id = ? FOR UPDATE', [id]);
    const cur = await getTodo(q, id);
    const seen = one(await q('SELECT todo_id FROM completion_events WHERE idempotency_key = ?', [key]));
    if (seen && seen.todo_id !== id) throw new HttpError(409, '이 요청 키는 다른 할 일에 이미 사용되었습니다');
    if (seen || cur.status === 'done') return { todo: cur, duplicate: true };
    const t = nowIso();
    // DB 제약(요청 키 UNIQUE, 유효 완료 할 일당 1건 부분 UNIQUE)이 마지막 방어선.
    const ins = await q('INSERT INTO completion_events (todo_id, idempotency_key, completed_at) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING id', [id, key, t]);
    if (!ins.length) return { todo: await getTodo(q, id), duplicate: true };
    await q("UPDATE todos SET status='done', completed_at=?, updated_at=? WHERE id=?", [t, t, id]);
    return { todo: await getTodo(q, id), duplicate: false };
  });
});
route('POST', '/api/todos/:id/reopen', async ({ params }) => {
  const id = idOf(params.id);
  return tx(async ({ query: q }) => {
    await q('SELECT id FROM todos WHERE id = ? FOR UPDATE', [id]);
    const cur = await getTodo(q, id);
    if (cur.status === 'open') return { todo: cur, duplicate: true };
    const t = nowIso();
    await q('UPDATE completion_events SET reopened_at = ? WHERE todo_id = ? AND reopened_at IS NULL', [t, id]);
    await q("UPDATE todos SET status='open', completed_at=NULL, updated_at=? WHERE id=?", [t, id]);
    return { todo: await getTodo(q, id), duplicate: false };
  });
});

route('POST', '/api/todos/:id/runs', async ({ params, body, headers }) => {
  const id = idOf(params.id);
  return tx(async ({ query: q }) => {
    await getTodo(q, id);
    const started = reqIso(body.started_at, '시작 시각');
    const ended = reqIso(body.ended_at, '끝난 시각');
    if (ended < started) throw bad('끝난 시각이 시작 시각보다 빠릅니다');
    const diff = Math.round((Date.parse(ended) - Date.parse(started)) / 60000);
    const actual = body.actual_min === undefined || body.actual_min === '' || body.actual_min === null
      ? diff : reqInt(body.actual_min, '실제 걸린 시간(분)', 0, 100000);
    const key = String(headers['idempotency-key'] || '').slice(0, 100) || null;
    if (key) {
      const dup = one(await q('SELECT * FROM runs WHERE idempotency_key = ?', [key]));
      if (dup && dup.todo_id !== id) throw new HttpError(409, '이 요청 키는 다른 할 일에 이미 사용되었습니다');
      if (dup) return { run: dup, duplicate: true };
    }
    const run = one(await q(`INSERT INTO runs (todo_id, started_at, ended_at, actual_min, blocked_reason, idempotency_key, created_at)
      VALUES (?,?,?,?,?,?,?) RETURNING *`, [id, started, ended, actual, optText(body.blocked_reason, 500), key, nowIso()]));
    return { run, duplicate: false };
  });
});
route('GET', '/api/runs', async ({ query: f }) => {
  const { sql, args } = todoWhere({ plan_id: f.plan_id, from: f.from, to: f.to }, seoulToday());
  return { runs: await query(`SELECT r.*, t.title AS todo_title, t.plan_id FROM runs r JOIN todos t ON t.id = r.todo_id
    WHERE ${sql} ORDER BY r.started_at DESC, r.id DESC`, args) };
});

route('GET', '/api/review', ({ query: f }) => review(query, f));

route('GET', '/api/reflections', async () => ({
  reflections: await query(`SELECT f.*, p.title AS carried_plan_title FROM reflections f
    LEFT JOIN plans p ON p.id = f.carried_plan_id ORDER BY f.id DESC`),
}));
route('POST', '/api/reflections', async ({ body }) => {
  const rows = await query(`INSERT INTO reflections (scope_plan_id, period_from, period_to, summary, improvement, created_at)
    VALUES (?,?,?,?,?,?) RETURNING *`, [
    body.scope_plan_id ? reqInt(body.scope_plan_id, 'scope_plan_id', 1, 2e9) : null,
    reqDate(body.period_from, 'from', true), reqDate(body.period_to, 'to', true),
    optText(body.summary, 1000), reqText(body.improvement, '고칠 점', 200), nowIso()]);
  return { reflection: rows[0] };
});
// 고칠 점 한 건 → 다음 계획(새 계획 + 첫 할 일)
route('POST', '/api/reflections/:id/carry', async ({ params, body }) => {
  const id = idOf(params.id);
  return tx(async ({ query: q }) => {
    const ref = one(await q('SELECT * FROM reflections WHERE id = ? FOR UPDATE', [id]));
    if (!ref) throw new HttpError(404, '돌아보기를 찾을 수 없습니다');
    if (ref.carried_plan_id) return { plan: await getPlan(q, ref.carried_plan_id), duplicate: true };
    const f = planFields({
      title: body.title || `다음 계획 — ${ref.improvement}`.slice(0, 120),
      period_start: body.period_start, period_end: body.period_end,
      priority: body.priority ?? 1,
      success_criteria: body.success_criteria || `이전 돌아보기에서 정한 고칠 점을 지킨다: ${ref.improvement}`,
      estimate_min: body.estimate_min ?? 60,
    });
    const planId = await insertPlan(q, f, id);
    await insertTodo(q, planId, { title: ref.improvement.slice(0, 200), due_date: f.period_end, priority: 1, estimate_min: f.estimate_min, tags: 'carried' });
    await q('UPDATE reflections SET carried_plan_id = ? WHERE id = ?', [planId, id]);
    return { plan: await getPlan(q, planId), duplicate: false };
  });
});

route('GET', '/api/export', async () => ({
  exported_at: nowIso(), timezone: 'Asia/Seoul', schema: 'pds-schema-v2',
  notes: '날짜는 YYYY-MM-DD(서울 달력 날짜), 시각은 UTC ISO-8601, 시간 길이는 분(min).',
  plans: await query('SELECT * FROM plans ORDER BY id'),
  plan_versions: await query('SELECT * FROM plan_versions ORDER BY plan_id, version'),
  todos: await query('SELECT * FROM todos ORDER BY id'),
  todo_tags: await query('SELECT * FROM todo_tags ORDER BY todo_id, tag'),
  runs: await query('SELECT * FROM runs ORDER BY id'),
  completion_events: await query('SELECT * FROM completion_events ORDER BY id'),
  reflections: await query('SELECT * FROM reflections ORDER BY id'),
}));

// ---------- HTTP ----------
export const SEC = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SEC, ...headers });
  res.end(body);
}
export function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) { // Vercel 이 미리 읽어 둔 경우
    if (Buffer.isBuffer(req.body)) req = { _raw: req.body };
    else if (typeof req.body === 'string') req = { _raw: Buffer.from(req.body) };
    else return typeof req.body === 'object' ? req.body : {};
  }
  const chunks = [];
  let size = 0;
  if (req._raw) chunks.push(req._raw);
  else for await (const c of req) { size += c.length; if (size > 100_000) throw new HttpError(413, '요청이 너무 큽니다'); chunks.push(c); }
  if (!chunks.length) return {};
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); return v && typeof v === 'object' ? v : {}; }
  catch { throw bad('JSON 형식이 올바르지 않습니다'); }
}

// 반환값: 처리했으면 true, /api/ 가 아니면 false
export async function handleApi(req, res, url) {
  if (!url.pathname.startsWith('/api/')) return false;
  try {
    await ensureSchema();
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const out = await r.handler({ params: m.groups || {}, query: Object.fromEntries(url.searchParams), body, headers: req.headers });
      sendJson(res, 200, out, url.pathname === '/api/export' ? { 'Content-Disposition': 'attachment; filename="plando-diary-export.json"' } : {});
      return true;
    }
    sendJson(res, 404, { error: '없는 주소입니다' });
  } catch (e) {
    if (e instanceof HttpError) sendJson(res, e.status, { error: e.message });
    else if (/^23/.test(String(e?.code)) || /violates|constraint|append-only/i.test(String(e?.message))) sendJson(res, 409, { error: '저장 규칙에 맞지 않는 값입니다' });
    else { console.error(e); sendJson(res, 500, { error: '서버 오류가 났습니다' }); }
  }
  return true;
}
