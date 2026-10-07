// API 로직. 로컬 서버(server.js)와 Vercel 함수(api/index.js)가 같이 쓴다.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
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

function todoWhere(q, today, uid) {
  // 모든 할 일 조회의 첫 조건: 내 계획에 딸린 것만 (목록·집계·기록 목록 공통)
  const w = ['t.deleted_at IS NULL', 't.plan_id IN (SELECT id FROM plans WHERE user_id = ?)'];
  const a = [uid];
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

async function getTodo(q, id, uid) {
  const today = seoulToday();
  const row = one(await q(`SELECT t.*, p.title AS plan_title FROM todos t JOIN plans p ON p.id = t.plan_id
    WHERE t.id = ? AND t.deleted_at IS NULL AND p.user_id = ?`, [id, uid]));
  if (!row) throw new HttpError(404, '할 일을 찾을 수 없습니다');
  return (await hydrateTodos(q, [row], today))[0];
}

async function listTodos(q, filters, uid) {
  const today = seoulToday();
  const sortKey = SORTS[filters.sort] ? filters.sort : 'due';
  const { sql, args } = todoWhere(filters, today, uid);
  const rows = await q(`SELECT t.*, p.title AS plan_title FROM todos t JOIN plans p ON p.id = t.plan_id
    WHERE ${sql} ORDER BY ${SORTS[sortKey].sql}`, args);
  return { today, sort: sortKey, sort_label: SORTS[sortKey].label, todos: await hydrateTodos(q, rows, today) };
}

async function getPlan(q, id, uid, lock = false) {
  // 남의 계획은 '없는 것'과 똑같이 404 로 답한다(존재 자체를 감춤).
  const p = one(await q(`SELECT * FROM plans WHERE id = ? AND user_id = ?${lock ? ' FOR UPDATE' : ''}`, [id, uid]));
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

async function insertPlan(q, uid, f, reflectionId = null) {
  const t = nowIso();
  const id = one(await q(`INSERT INTO plans (title, period_start, period_end, priority, success_criteria, estimate_min,
      carried_from_reflection_id, created_at, updated_at, user_id) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  [f.title, f.period_start, f.period_end, f.priority, f.success_criteria, f.estimate_min, reflectionId, t, t, uid])).id;
  await snapshotPlan(q, id, 1, f, t);
  return id;
}

async function setTags(q, todoId, tags) {
  await q('DELETE FROM todo_tags WHERE todo_id = ?', [todoId]);
  for (const tag of tags) await q('INSERT INTO todo_tags (todo_id, tag) VALUES (?,?)', [todoId, tag]);
}

async function insertTodo(q, uid, planId, b) {
  await getPlan(q, planId, uid);
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
async function review(q, p, uid) {
  const today = seoulToday();
  const { sql, args } = todoWhere({ plan_id: p.plan_id, from: p.from, to: p.to }, today, uid);
  const sums = one(await q(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0) AS done,
      COALESCE(SUM(CASE WHEN ${overdueSql} THEN 1 ELSE 0 END), 0) AS overdue,
      COALESCE(SUM(CASE WHEN ${blockedSql} THEN 1 ELSE 0 END), 0) AS blocked,
      COALESCE(SUM(t.estimate_min), 0) AS expected
    FROM todos t WHERE ${sql}`, [today, ...args]));
  const actual = one(await q(`SELECT COALESCE(SUM(r.actual_min), 0) AS m FROM runs r
    JOIN todos t ON t.id = r.todo_id WHERE ${sql}`, args)).m;
  const pw = ['period_start <= ?', 'period_end >= ?', 'user_id = ?'];
  const pa = [p.to ? reqDate(p.to, 'to') : '9999-12-31', p.from ? reqDate(p.from, 'from') : '0001-01-01', uid];
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
const route = (method, pattern, handler, opts = {}) => routes.push({ method, public: !!opts.public, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });
const idOf = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 2e9) throw new HttpError(404, '없는 주소입니다'); return n; };

// ---------- 인증 ----------
const COOKIE = 'pds_session';
const SESSION_DAYS = 7;
const BCRYPT_COST = 12;
const LOGIN_FAIL = '이메일 또는 비밀번호가 올바르지 않습니다'; // 아이디 없음/비밀번호 틀림 모두 같은 문구
let dummyHash;
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function cookieAttrs(headers) {
  const secure = headers['x-forwarded-proto'] === 'https' || !!process.env.VERCEL;
  return `HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
}
const setCookie = (res, token, headers) => res.setHeader('Set-Cookie', `${COOKIE}=${token}; Max-Age=${SESSION_DAYS * 86400}; ${cookieAttrs(headers)}`);
const clearCookie = (res, headers) => res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieAttrs(headers)}`);

function validEmail(v) {
  if (typeof v !== 'string') throw bad('이메일을 입력하세요');
  const e = v.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw bad('이메일 형식이 올바르지 않습니다');
  return e;
}
function validPassword(v) {
  if (typeof v !== 'string' || v.length < 10) throw bad('비밀번호는 10자 이상이어야 합니다');
  if (Buffer.byteLength(v) > 72) throw bad('비밀번호는 72바이트 이하여야 합니다');
  return v;
}

async function startSession(q, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await q('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?', [userId, new Date(now).toISOString()]);
  await q('INSERT INTO sessions (user_id, token_hash, created_at, expires_at) VALUES (?,?,?,?)',
    [userId, sha256(token), new Date(now).toISOString(), new Date(now + SESSION_DAYS * 864e5).toISOString()]);
  return token;
}
async function userFromRequest(headers) {
  const token = parseCookies(headers.cookie)[COOKIE];
  if (!token) return null;
  const row = one(await query(`SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`, [sha256(token), nowIso()]));
  return row || null;
}
// 과제 6 에서 넘어온 '주인 없는' 자료를 지정한 이메일(환경변수 LEGACY_OWNER_EMAIL)의 계정으로 옮긴다.
async function claimLegacy(q, user) {
  const owner = String(process.env.LEGACY_OWNER_EMAIL || '').trim().toLowerCase();
  if (!owner || owner !== user.email) return;
  await q('UPDATE plans SET user_id = ? WHERE user_id IS NULL', [user.id]);
  await q('UPDATE reflections SET user_id = ? WHERE user_id IS NULL', [user.id]);
}
async function checkPassword(userId, password) {
  const row = one(await query('SELECT password_hash FROM users WHERE id = ?', [userId]));
  if (!row || typeof password !== 'string' || !(await bcrypt.compare(password, row.password_hash))) throw new HttpError(403, '현재 비밀번호가 올바르지 않습니다');
}

route('GET', '/api/health', async () => ({ ok: true, today_seoul: seoulToday() }), { public: true });

route('POST', '/api/auth/register', async ({ body, res, headers }) => {
  const email = validEmail(body.email);
  const hash = await bcrypt.hash(validPassword(body.password), BCRYPT_COST);
  const out = await tx(async ({ query: q }) => {
    const ins = await q('INSERT INTO users (email, password_hash, created_at) VALUES (?,?,?) ON CONFLICT (email) DO NOTHING RETURNING id', [email, hash, nowIso()]);
    if (!ins.length) throw new HttpError(409, '이미 가입된 이메일입니다');
    const user = { id: ins[0].id, email };
    await claimLegacy(q, user);
    return { user, token: await startSession(q, user.id) };
  });
  setCookie(res, out.token, headers);
  return { user: { email: out.user.email } };
}, { public: true });

route('POST', '/api/auth/login', async ({ body, res, headers }) => {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const row = email ? one(await query('SELECT id, email, password_hash FROM users WHERE email = ?', [email])) : null;
  dummyHash ??= await bcrypt.hash('timing-equalizer-not-a-real-password', BCRYPT_COST);
  // 아이디가 없어도 같은 비용의 비교를 해서 응답 시간 차이로 가입 여부가 드러나지 않게 한다.
  const ok = await bcrypt.compare(typeof body.password === 'string' ? body.password : '', row ? row.password_hash : dummyHash);
  if (!row || !ok) throw new HttpError(401, LOGIN_FAIL);
  const token = await tx(async ({ query: q }) => { await claimLegacy(q, row); return startSession(q, row.id); });
  setCookie(res, token, headers);
  return { user: { email: row.email } };
}, { public: true });

route('POST', '/api/auth/logout', async ({ res, headers }) => {
  const token = parseCookies(headers.cookie)[COOKIE];
  if (token) await query('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]); // 서버에서도 끊는다
  clearCookie(res, headers);
  return { ok: true };
}, { public: true });

route('GET', '/api/me', async ({ user }) => ({ user: { email: user.email } }));

route('POST', '/api/account/password', async ({ user, body, res, headers }) => {
  await checkPassword(user.id, body.current_password);
  const hash = await bcrypt.hash(validPassword(body.new_password), BCRYPT_COST);
  const token = await tx(async ({ query: q }) => {
    await q('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id]);
    await q('DELETE FROM sessions WHERE user_id = ?', [user.id]); // 이전에 발급한 값은 모두 무효
    return startSession(q, user.id);
  });
  setCookie(res, token, headers);
  return { ok: true };
});

route('DELETE', '/api/account', async ({ user, body, res, headers }) => {
  await checkPassword(user.id, body.password);
  await tx(async ({ query: q }) => {
    await q("SELECT set_config('pds.account_delete', 'on', true)");
    const mine = '(SELECT id FROM plans WHERE user_id = ?)';
    const myTodos = `(SELECT id FROM todos WHERE plan_id IN ${mine})`;
    const u = [user.id];
    await q(`DELETE FROM completion_events WHERE todo_id IN ${myTodos}`, u);
    await q(`DELETE FROM runs WHERE todo_id IN ${myTodos}`, u);
    await q(`DELETE FROM todo_tags WHERE todo_id IN ${myTodos}`, u);
    await q(`DELETE FROM todos WHERE plan_id IN ${mine}`, u);
    await q(`DELETE FROM plan_versions WHERE plan_id IN ${mine}`, u);
    await q('DELETE FROM reflections WHERE user_id = ?', u);
    await q('DELETE FROM plans WHERE user_id = ?', u);
    await q('DELETE FROM plan_rule_changes WHERE user_id = ?', u);
    await q('DELETE FROM diary_days WHERE user_id = ?', u);
    await q('DELETE FROM experiments WHERE user_id = ?', u);
    await q('DELETE FROM sessions WHERE user_id = ?', u);
    await q('DELETE FROM users WHERE id = ?', u);
  });
  clearCookie(res, headers);
  return { deleted: true };
});

// ---------- 계획 ----------
const publicPlan = ({ user_id, ...p }) => p;
route('GET', '/api/plans', async ({ user }) => ({
  plans: (await query(`SELECT p.*,
      (SELECT COUNT(*) FROM todos t WHERE t.plan_id = p.id AND t.deleted_at IS NULL)::int AS todo_count,
      (SELECT COUNT(*) FROM todos t WHERE t.plan_id = p.id AND t.deleted_at IS NULL AND t.status = 'done')::int AS done_count,
      (SELECT COUNT(*) FROM plan_versions v WHERE v.plan_id = p.id)::int AS version_count
    FROM plans p WHERE p.user_id = ? ORDER BY p.period_start DESC, p.id DESC`, [user.id])).map(publicPlan),
}));
route('POST', '/api/plans', async ({ body, user }) => {
  const f = planFields(body);
  return tx(async (t) => ({ plan: publicPlan(await getPlan(t.query, await insertPlan(t.query, user.id, f), user.id)) }));
});
route('PATCH', '/api/plans/:id', async ({ params, body, user }) => {
  const id = idOf(params.id);
  return tx(async ({ query: q }) => {
    const cur = await getPlan(q, id, user.id, true);
    const f = planFields(body, cur);
    if (!Object.keys(f).every((k) => f[k] === cur[k])) {
      const t = nowIso();
      const ver = one(await q('SELECT MAX(version) AS v FROM plan_versions WHERE plan_id = ?', [id])).v + 1;
      await q(`UPDATE plans SET title=?, period_start=?, period_end=?, priority=?, success_criteria=?, estimate_min=?,
        updated_at=? WHERE id=? AND user_id=?`, [f.title, f.period_start, f.period_end, f.priority, f.success_criteria, f.estimate_min, t, id, user.id]);
      await snapshotPlan(q, id, ver, f, t);
    }
    return { plan: publicPlan(await getPlan(q, id, user.id)) };
  });
});
route('GET', '/api/plans/:id/versions', async ({ params, user }) => {
  const id = idOf(params.id);
  await getPlan(query, id, user.id);
  return { versions: await query('SELECT * FROM plan_versions WHERE plan_id = ? ORDER BY version', [id]) };
});

// ---------- 할 일 ----------
route('GET', '/api/todos', ({ query: f, user }) => listTodos(query, f, user.id));
route('GET', '/api/todos/:id', async ({ params, user }) => {
  const todo = await getTodo(query, idOf(params.id), user.id);
  return {
    todo,
    runs: await query('SELECT * FROM runs WHERE todo_id = ? ORDER BY started_at, id', [todo.id]),
    completions: await query('SELECT * FROM completion_events WHERE todo_id = ? ORDER BY id', [todo.id]),
  };
});
route('POST', '/api/plans/:id/todos', async ({ params, body, user }) => {
  const pid = idOf(params.id);
  return tx(async ({ query: q }) => ({ todo: await getTodo(q, await insertTodo(q, user.id, pid, body), user.id) }));
});
route('PATCH', '/api/todos/:id', async ({ params, body, user }) => {
  const id = idOf(params.id);
  return tx(async ({ query: q }) => {
    const cur = await getTodo(q, id, user.id); // 주인 확인이 저장보다 먼저
    const f = {
      title: reqText(body.title ?? cur.title, '할 일 제목', 200),
      due_date: 'due_date' in body ? reqDate(body.due_date, '마감일', true) : cur.due_date,
      priority: reqInt(body.priority ?? cur.priority, '우선순위', 1, 3),
      estimate_min: reqInt(body.estimate_min ?? cur.estimate_min, '예상 시간(분)', 0, 100000),
    };
    await q('UPDATE todos SET title=?, due_date=?, priority=?, estimate_min=?, updated_at=? WHERE id=?',
      [f.title, f.due_date, f.priority, f.estimate_min, nowIso(), id]);
    if ('tags' in body) await setTags(q, id, parseTags(body.tags));
    return { todo: await getTodo(q, id, user.id) };
  });
});
route('DELETE', '/api/todos/:id', async ({ params, user }) => {
  const id = idOf(params.id);
  return tx(async ({ query: q }) => {
    await getTodo(q, id, user.id);
    const t = nowIso();
    await q('UPDATE todos SET deleted_at = ?, updated_at = ? WHERE id = ?', [t, t, id]);
    return { deleted: true, id };
  });
});

// 내 할 일 행만 잠근다. 없거나 남의 것이면 404.
async function lockTodo(q, id, uid) {
  const r = await q(`SELECT t.id FROM todos t JOIN plans p ON p.id = t.plan_id
    WHERE t.id = ? AND p.user_id = ? FOR UPDATE OF t`, [id, uid]);
  if (!r.length) throw new HttpError(404, '할 일을 찾을 수 없습니다');
}
route('POST', '/api/todos/:id/complete', async ({ params, headers, user }) => {
  const id = idOf(params.id);
  const key = String(headers['idempotency-key'] || '').slice(0, 100) || crypto.randomUUID();
  return tx(async ({ query: q }) => {
    await lockTodo(q, id, user.id);
    const cur = await getTodo(q, id, user.id);
    const seen = one(await q('SELECT todo_id FROM completion_events WHERE idempotency_key = ?', [key]));
    if (seen && seen.todo_id !== id) throw new HttpError(409, '이 요청 키는 다른 할 일에 이미 사용되었습니다');
    if (seen || cur.status === 'done') return { todo: cur, duplicate: true };
    const t = nowIso();
    const ins = await q('INSERT INTO completion_events (todo_id, idempotency_key, completed_at) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING id', [id, key, t]);
    if (!ins.length) return { todo: await getTodo(q, id, user.id), duplicate: true };
    await q("UPDATE todos SET status='done', completed_at=?, updated_at=? WHERE id=?", [t, t, id]);
    return { todo: await getTodo(q, id, user.id), duplicate: false };
  });
});
route('POST', '/api/todos/:id/reopen', async ({ params, user }) => {
  const id = idOf(params.id);
  return tx(async ({ query: q }) => {
    await lockTodo(q, id, user.id);
    const cur = await getTodo(q, id, user.id);
    if (cur.status === 'open') return { todo: cur, duplicate: true };
    const t = nowIso();
    await q('UPDATE completion_events SET reopened_at = ? WHERE todo_id = ? AND reopened_at IS NULL', [t, id]);
    await q("UPDATE todos SET status='open', completed_at=NULL, updated_at=? WHERE id=?", [t, id]);
    return { todo: await getTodo(q, id, user.id), duplicate: false };
  });
});

route('POST', '/api/todos/:id/runs', async ({ params, body, headers, user }) => {
  const id = idOf(params.id);
  return tx(async ({ query: q }) => {
    await getTodo(q, id, user.id);
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
route('GET', '/api/runs', async ({ query: f, user }) => {
  const { sql, args } = todoWhere({ plan_id: f.plan_id, from: f.from, to: f.to }, seoulToday(), user.id);
  return { runs: await query(`SELECT r.*, t.title AS todo_title, t.plan_id FROM runs r JOIN todos t ON t.id = r.todo_id
    WHERE ${sql} ORDER BY r.started_at DESC, r.id DESC`, args) };
});

route('GET', '/api/review', ({ query: f, user }) => review(query, f, user.id));

route('GET', '/api/reflections', async ({ user }) => ({
  reflections: await query(`SELECT f.id, f.scope_plan_id, f.period_from, f.period_to, f.summary, f.improvement, f.carried_plan_id,
      f.created_at, p.title AS carried_plan_title FROM reflections f
    LEFT JOIN plans p ON p.id = f.carried_plan_id WHERE f.user_id = ? ORDER BY f.id DESC`, [user.id]),
}));
route('POST', '/api/reflections', async ({ body, user }) => {
  const scope = body.scope_plan_id ? reqInt(body.scope_plan_id, 'scope_plan_id', 1, 2e9) : null;
  if (scope) await getPlan(query, scope, user.id); // 남의 계획을 범위로 못 건다
  const rows = await query(`INSERT INTO reflections (scope_plan_id, period_from, period_to, summary, improvement, created_at, user_id)
    VALUES (?,?,?,?,?,?,?) RETURNING id, scope_plan_id, period_from, period_to, summary, improvement, carried_plan_id, created_at`, [
    scope, reqDate(body.period_from, 'from', true), reqDate(body.period_to, 'to', true),
    optText(body.summary, 1000), reqText(body.improvement, '고칠 점', 200), nowIso(), user.id]);
  return { reflection: rows[0] };
});
route('POST', '/api/reflections/:id/carry', async ({ params, body, user }) => {
  const id = idOf(params.id);
  return tx(async ({ query: q }) => {
    const ref = one(await q('SELECT * FROM reflections WHERE id = ? AND user_id = ? FOR UPDATE', [id, user.id]));
    if (!ref) throw new HttpError(404, '돌아보기를 찾을 수 없습니다');
    if (ref.carried_plan_id) return { plan: publicPlan(await getPlan(q, ref.carried_plan_id, user.id)), duplicate: true };
    const f = planFields({
      title: body.title || `다음 계획 — ${ref.improvement}`.slice(0, 120),
      period_start: body.period_start, period_end: body.period_end,
      priority: body.priority ?? 1,
      success_criteria: body.success_criteria || `이전 돌아보기에서 정한 고칠 점을 지킨다: ${ref.improvement}`,
      estimate_min: body.estimate_min ?? 60,
    });
    const planId = await insertPlan(q, user.id, f, id);
    await insertTodo(q, user.id, planId, { title: ref.improvement.slice(0, 200), due_date: f.period_end, priority: 1, estimate_min: f.estimate_min, tags: 'carried' });
    await q('UPDATE reflections SET carried_plan_id = ? WHERE id = ?', [planId, id]);
    return { plan: publicPlan(await getPlan(q, planId, user.id)), duplicate: false };
  });
});

route('GET', '/api/export', async ({ user }) => {
  const u = [user.id];
  const mine = '(SELECT id FROM plans WHERE user_id = ?)';
  const myTodos = `(SELECT id FROM todos WHERE plan_id IN ${mine})`;
  return {
    exported_at: nowIso(), timezone: 'Asia/Seoul', schema: 'pds-schema-v3', owner_email: user.email,
    notes: '날짜는 YYYY-MM-DD(서울 달력 날짜), 시각은 UTC ISO-8601, 시간 길이는 분(min). 본인 자료만 포함합니다.',
    plans: (await query('SELECT * FROM plans WHERE user_id = ? ORDER BY id', u)).map(publicPlan),
    plan_versions: await query(`SELECT * FROM plan_versions WHERE plan_id IN ${mine} ORDER BY plan_id, version`, u),
    todos: await query(`SELECT * FROM todos WHERE plan_id IN ${mine} ORDER BY id`, u),
    todo_tags: await query(`SELECT * FROM todo_tags WHERE todo_id IN ${myTodos} ORDER BY todo_id, tag`, u),
    runs: await query(`SELECT * FROM runs WHERE todo_id IN ${myTodos} ORDER BY id`, u),
    completion_events: await query(`SELECT * FROM completion_events WHERE todo_id IN ${myTodos} ORDER BY id`, u),
    reflections: await query('SELECT id, scope_plan_id, period_from, period_to, summary, improvement, carried_plan_id, created_at FROM reflections WHERE user_id = ? ORDER BY id', u),
    experiment: (await query('SELECT * FROM experiments WHERE user_id = ?', u)).map(({ user_id, ...e }) => e)[0] || null,
    diary_days: (await query('SELECT * FROM diary_days WHERE user_id = ? ORDER BY day_no', u)).map(({ user_id, ...d }) => d),
    plan_rule_changes: (await query('SELECT * FROM plan_rule_changes WHERE user_id = ?', u)).map(({ user_id, ...c }) => c),
  };
});

// ---------- 5일 실험 ----------
const EXP_FIXED = {
  metric_name: '하루 계획 시간과 실제 시간의 차이',
  unit: '분',
  calc_rule: '차이(분) = 그날 실제로 쓴 시간(분) − 그날 계획한 시간(분). 양수면 계획보다 더 걸림.',
  missing_rule: '기록이 없는 날은 0으로 치지 않고 계산에서 뺀다. 평균은 기록이 있는 날만으로 낸다.',
  duplicate_rule: '같은 날짜(서울)에 다시 저장하면 새 줄을 만들지 않고 그날 값을 마지막 저장 값으로 바꾼다. 날짜는 서버가 정한다.',
  outlier_rule: '차이의 절댓값이 240분을 넘으면 "튀는 값"으로 표시하되 제외하지 않고 합계·평균에 그대로 넣는다.',
  rounding_rule: '평균은 소수 첫째 자리에서 반올림해 정수 분으로 보인다(정확히 .5는 0에서 먼 쪽으로). 합계는 정수라 반올림이 없다.',
  week_start: '월요일',
};
const OUTLIER_MIN = 240;
const roundHalfAway = (x) => Math.sign(x) * Math.round(Math.abs(x));
const seoulWeekStart = (d) => { // YYYY-MM-DD → 그 주 월요일
  const dt = new Date(d + 'T00:00:00Z');
  const back = (dt.getUTCDay() + 6) % 7;
  return new Date(dt.getTime() - back * 864e5).toISOString().slice(0, 10);
};
const dayView = (d) => ({
  id: d.id, day_no: d.day_no, date: d.day_date, planned_min: d.planned_min, actual_min: d.actual_min,
  diff_min: d.actual_min - d.planned_min, outlier: Math.abs(d.actual_min - d.planned_min) > OUTLIER_MIN,
  note: d.note, created_at: d.created_at, updated_at: d.updated_at,
});
function summarize(days) {
  const stat = (arr) => {
    const total = arr.reduce((s, d) => s + d.diff_min, 0);
    return { days: arr.length, total_diff_min: total, avg_diff_min: arr.length ? roundHalfAway(total / arr.length) : null };
  };
  const weeks = {};
  for (const d of days) (weeks[seoulWeekStart(d.date)] ??= []).push(d);
  return { all: stat(days), by_week: Object.entries(weeks).map(([week_start, arr]) => ({ week_start, ...stat(arr) })) };
}
async function loadExperiment(q, uid) {
  const exp = one(await q('SELECT * FROM experiments WHERE user_id = ?', [uid]));
  const days = (await q('SELECT * FROM diary_days WHERE user_id = ? ORDER BY day_no', [uid])).map(dayView);
  const change = one(await q('SELECT * FROM plan_rule_changes WHERE user_id = ?', [uid]));
  const out = {
    experiment: exp ? (({ user_id, ...e }) => e)(exp) : null, days,
    rule_change: change ? (({ user_id, ...c }) => c)(change) : null,
    summary: summarize(days),
  };
  if (change) {
    const d2 = days.find((d) => d.id === change.after_day2_id);
    const before = days.filter((d) => d.day_no <= d2.day_no);
    const after = days.filter((d) => d.day_no > d2.day_no);
    // 같은 지표·같은 단위·같은 계산 규칙으로 규칙 변경 전(1~2일차)과 후(3일차~)를 비교
    out.comparison = {
      metric: exp.metric_name, unit: exp.unit, calc_rule: exp.calc_rule,
      before: { rule: change.old_rule, ...summarize(before).all }, after: { rule: change.new_rule, ...summarize(after).all },
    };
  }
  return out;
}
route('GET', '/api/experiment', ({ user }) => loadExperiment(query, user.id));
route('POST', '/api/experiment', async ({ body, user }) => {
  const question = reqText(body.question, '질문', 200);
  const rule = reqText(body.initial_plan_rule, '처음 계획 규칙', 300);
  const r = await query(`INSERT INTO experiments (user_id, question, metric_name, unit, calc_rule, missing_rule, duplicate_rule,
      outlier_rule, rounding_rule, week_start, initial_plan_rule, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (user_id) DO NOTHING RETURNING id`,
  [user.id, question, EXP_FIXED.metric_name, EXP_FIXED.unit, EXP_FIXED.calc_rule, EXP_FIXED.missing_rule, EXP_FIXED.duplicate_rule,
    EXP_FIXED.outlier_rule, EXP_FIXED.rounding_rule, EXP_FIXED.week_start, rule, nowIso()]);
  if (!r.length) throw new HttpError(409, '질문과 지표는 1일차에 한 번 고정되며 바꿀 수 없습니다');
  return loadExperiment(query, user.id);
});
route('POST', '/api/experiment/days', async ({ body, user }) => {
  const planned = reqInt(body.planned_min, '계획한 시간(분)', 0, 1440);
  const actual = reqInt(body.actual_min, '실제 쓴 시간(분)', 0, 1440);
  const note = optText(body.note, 300);
  const today = seoulToday(); // 날짜는 서버가 정한다: 5일이 실제로 서로 다른 날이 되도록
  return tx(async ({ query: q }) => {
    await q('SELECT id FROM users WHERE id = ? FOR UPDATE', [user.id]);
    if (!one(await q('SELECT id FROM experiments WHERE user_id = ?', [user.id]))) throw new HttpError(409, '먼저 1일차에 질문을 고정하세요');
    const days = await q('SELECT * FROM diary_days WHERE user_id = ? ORDER BY day_no', [user.id]);
    const t = nowIso();
    const same = days.find((d) => d.day_date === today);
    if (same) {
      await q('UPDATE diary_days SET planned_min=?, actual_min=?, note=?, updated_at=? WHERE id=?', [planned, actual, note, t, same.id]);
    } else {
      if (days.length >= 5) throw new HttpError(409, '5일 기록이 이미 모두 있습니다');
      if (days.length === 2 && !one(await q('SELECT id FROM plan_rule_changes WHERE user_id = ?', [user.id]))) {
        throw new HttpError(409, '3일차에 들어가기 전에 계획 규칙을 하나 바꿔 기록해야 합니다');
      }
      await q(`INSERT INTO diary_days (user_id, day_date, day_no, planned_min, actual_min, note, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?)`, [user.id, today, days.length + 1, planned, actual, note, t, t]);
    }
    return loadExperiment(q, user.id);
  });
});
route('POST', '/api/experiment/rule-change', async ({ body, user }) => {
  const newRule = reqText(body.new_rule, '새 계획 규칙', 300);
  const reason = reqText(body.reason, '바꾼 이유', 300);
  return tx(async ({ query: q }) => {
    await q('SELECT id FROM users WHERE id = ? FOR UPDATE', [user.id]);
    const exp = one(await q('SELECT * FROM experiments WHERE user_id = ?', [user.id]));
    if (!exp) throw new HttpError(409, '먼저 1일차에 질문을 고정하세요');
    const days = await q('SELECT * FROM diary_days WHERE user_id = ? ORDER BY day_no', [user.id]);
    if (days.length !== 2) throw new HttpError(409, '규칙은 2일차 기록 뒤, 3일차 기록 앞에서만 바꿀 수 있습니다');
    const ins = await q(`INSERT INTO plan_rule_changes (user_id, old_rule, new_rule, reason, after_day1_id, after_day2_id, changed_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT (user_id) DO NOTHING RETURNING id`, [user.id, exp.initial_plan_rule, newRule, reason, days[0].id, days[1].id, nowIso()]);
    if (!ins.length) throw new HttpError(409, '계획 규칙은 한 번만 바꿀 수 있습니다');
    return loadExperiment(q, user.id);
  });
});

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
      // 상태를 바꾸는 요청은 다른 사이트에서 온 것이면 거절(CSRF 방어: SameSite=Lax 쿠키와 함께 이중으로)
      if (req.method !== 'GET' && req.headers.origin) {
        let host = '';
        try { host = new URL(req.headers.origin).host; } catch { /* 아래에서 거절 */ }
        if (host !== (req.headers['x-forwarded-host'] || req.headers.host)) throw new HttpError(403, '허용되지 않은 출처의 요청입니다');
      }
      const user = await userFromRequest(req.headers);
      if (!r.public && !user) throw new HttpError(401, '로그인이 필요합니다');
      const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      const out = await r.handler({ params: m.groups || {}, query: Object.fromEntries(url.searchParams), body, headers: req.headers, user, res });
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
