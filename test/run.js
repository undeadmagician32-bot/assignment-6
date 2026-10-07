// 임시 DB로 서버를 띄워 통과 기준(T06-C04~C36, C57, C82)을 API 수준에서 점검한다.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pds-'));
process.env.PGLITE_DIR = 'memory://';
const { server } = await import('../local-server.js');
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let cookie = '';
const call = async (m, u, b, h = {}) => {
  const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...h }, body: b ? JSON.stringify(b) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
  return { status: r.status, ...(await r.json()) };
};
const PW_A = 'test-pass-A-' + Math.random().toString(36).slice(2);
const reg = await call('POST', '/api/auth/register', { email: 'a@test.dev', password: PW_A });
if (reg.status !== 200) throw new Error('register failed ' + JSON.stringify(reg));
let n = 0;
const ok = async (name, fn) => {
  try { await fn(); n++; console.log('ok  ', name); }
  catch (e) { console.log('FAIL', name, '\n  ', e.message); process.exitCode = 1; }
};
const seoul = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
const addDays = (k) => seoul(new Date(Date.now() + k * 864e5));
const XSS = '<script>alert(1)</script>';

const p = (await call('POST', '/api/plans', { title: XSS, period_start: addDays(-10), period_end: addDays(10), priority: 1, success_criteria: '주 3회', estimate_min: 600 })).plan;
await ok('C04-07 기간·우선순위·성공 기준·예상 시간 저장', () => {
  assert.equal(p.period_start, addDays(-10)); assert.equal(p.priority, 1);
  assert.equal(p.success_criteria, '주 3회'); assert.equal(p.estimate_min, 600);
});
await call('PATCH', `/api/plans/${p.id}`, { success_criteria: '주 4회', estimate_min: 700 });
const vs = (await call('GET', `/api/plans/${p.id}/versions`)).versions;
await ok('C08 고쳐도 처음 계획 유지(v1 그대로, ID 그대로)', () => {
  assert.equal(vs.length, 2); assert.equal(vs[0].success_criteria, '주 3회'); assert.equal(vs[0].estimate_min, 600);
  assert.equal(vs[1].estimate_min, 700); assert.equal(vs[1].plan_id, p.id);
});

const mk = async (title, due, pri, tags, est) => (await call('POST', `/api/plans/${p.id}/todos`, { title, due_date: due, priority: pri, tags, estimate_min: est })).todo;
const a = await mk('A 지난 마감', addDays(-3), 1, 'x,y', 60);
const b = await mk('B 오늘', addDays(0), 2, 'x', 30);
const c = await mk('C 미래', addDays(5), 3, '', 90);
const d = await mk('D 마감없음', null, 2, 'z', 20);
const e = await mk('E 지난 마감2', addDays(-1), 2, '', 40);
await ok('C09,14-17 만들기·마감·우선순위·태그·예상', () => {
  assert.equal(a.due_date, addDays(-3)); assert.equal(a.priority, 1); assert.deepEqual(a.tags, ['x', 'y']); assert.equal(a.estimate_min, 60);
});
const upd = (await call('PATCH', `/api/todos/${c.id}`, { title: 'C 고침', estimate_min: 95 })).todo;
await ok('C10 수정', () => { assert.equal(upd.title, 'C 고침'); assert.equal(upd.estimate_min, 95); });

const q = (s) => call('GET', '/api/todos?' + s);
await ok('C18 검색', async () => assert.deepEqual((await q('q=고침')).todos.map((t) => t.id), [c.id]));
await ok('C19 태그 거르기', async () => assert.deepEqual((await q('tag=x')).todos.map((t) => t.id).sort(), [a.id, b.id].sort()));
await ok('C20 마감일 정렬 + 기준 문구', async () => {
  const r = await q('sort=due');
  assert.deepEqual(r.todos.map((t) => t.id), [a.id, e.id, b.id, c.id, d.id]); assert.ok(r.sort_label.includes('마감일'));
});
await ok('C20 우선순위 정렬(동률은 마감→번호)', async () =>
  assert.deepEqual((await q('sort=priority')).todos.map((t) => t.id), [a.id, e.id, b.id, d.id, c.id]));

const key = 'k-' + Math.random();
const [r1, r2] = await Promise.all([1, 2].map(() => call('POST', `/api/todos/${a.id}/complete`, {}, { 'Idempotency-Key': key })));
const r3 = await call('POST', `/api/todos/${a.id}/complete`, {}, { 'Idempotency-Key': 'other-' + key });
const det = await call('GET', `/api/todos/${a.id}`);
await ok('C11 완료', () => assert.equal(det.todo.status, 'done'));
await ok('C21 연달아 눌러도 완료 기록 1건', () => {
  assert.equal(det.completions.length, 1); assert.equal([r1, r2, r3].filter((x) => !x.duplicate).length, 1);
});
await ok('C22 돌아보기 완료 수 정확히 1', async () => assert.equal((await call('GET', `/api/review?plan_id=${p.id}`)).done, 1));
await ok('C12 되돌리기', async () => assert.equal((await call('POST', `/api/todos/${a.id}/reopen`)).todo.status, 'open'));
await call('POST', `/api/todos/${a.id}/complete`, {}, { 'Idempotency-Key': 'again' });
await ok('재완료 후에도 유효 완료 1건', async () => assert.equal((await call('GET', `/api/todos/${a.id}`)).todo.active_completions, 1));

await ok('다른 할 일에 같은 키 재사용은 409', async () => {
  assert.equal((await call('POST', `/api/todos/${c.id}/complete`, {}, { 'Idempotency-Key': key })).status, 409);
  assert.equal((await call('GET', `/api/todos/${c.id}`)).todo.status, 'open');
});
const t0 = new Date(Date.now() - 3600e3).toISOString();
const t1 = new Date().toISOString();
const run = (await call('POST', `/api/todos/${b.id}/runs`, { started_at: t0, ended_at: t1, actual_min: 50, blocked_reason: '자료 부족' })).run;
await call('POST', `/api/todos/${a.id}/runs`, { started_at: t0, ended_at: t1, actual_min: 45 });
const afterB = (await call('GET', `/api/todos/${b.id}`)).todo;
await ok('C23-26 실행 기록 저장', () => {
  assert.equal(run.started_at, t0); assert.equal(run.ended_at, t1); assert.equal(run.actual_min, 50); assert.equal(run.blocked_reason, '자료 부족');
});
await ok('C27 원래 계획 값 안 덮어씀', () => { assert.equal(afterB.estimate_min, 30); assert.equal(afterB.due_date, addDays(0)); });

await ok('실행 기록 키 재사용(다른 할 일)은 409', async () => {
  const body = { started_at: t0, ended_at: t1, actual_min: 0 };
  assert.equal((await call('POST', `/api/todos/${c.id}/runs`, body, { 'Idempotency-Key': 'rk' })).status, 200);
  assert.equal((await call('POST', `/api/todos/${d.id}/runs`, body, { 'Idempotency-Key': 'rk' })).status, 409);
  assert.equal((await call('POST', `/api/todos/${c.id}/runs`, body, { 'Idempotency-Key': 'rk' })).duplicate, true);
});
const del = await mk('F 지울 것', addDays(-2), 2, '', 15);
await call('DELETE', `/api/todos/${del.id}`);
await ok('C13 삭제 후 조회 안 됨', async () => assert.equal((await call('GET', `/api/todos/${del.id}`)).status, 404));

const rv = await call('GET', `/api/review?plan_id=${p.id}`);
await ok('C28 계획 수 = 지우지 않은 할 일 수', () => assert.equal(rv.planned, 5));
await ok('C29 완료 수', () => assert.equal(rv.done, 1));
await ok('C30 지연 수(완료·삭제·오늘 제외)', () => assert.equal(rv.overdue, 1));
await ok('C31 막힘 수', () => assert.equal(rv.blocked, 1));
await ok('C32 예상/실제/차이', () => {
  assert.equal(rv.expected_min, 60 + 30 + 95 + 20 + 40); assert.equal(rv.actual_min, 95); assert.equal(rv.diff_min, 95 - rv.expected_min);
});
const empty = await call('GET', '/api/review?plan_id=999999');
await ok('C32 아무것도 없으면 0', () => assert.deepEqual([empty.planned, empty.expected_min, empty.actual_min, empty.diff_min], [0, 0, 0, 0]));
const cnt = async (s) => (await q(`plan_id=${p.id}&${s}`)).todos.length;
await ok('C83 집계 숫자 = 눌러서 가는 목록 건수', async () =>
  assert.deepEqual([await cnt(''), await cnt('status=done'), await cnt('overdue=1'), await cnt('blocked=1')], [rv.planned, rv.done, rv.overdue, rv.blocked]));
await ok('C83 실제 시간 = 실행 기록 합', async () =>
  assert.equal((await call('GET', `/api/runs?plan_id=${p.id}`)).runs.reduce((s, r) => s + r.actual_min, 0), rv.actual_min));

const ref = (await call('POST', '/api/reflections', { improvement: '예상을 20% 넉넉히' })).reflection;
const c1 = await call('POST', `/api/reflections/${ref.id}/carry`, { period_start: addDays(0), period_end: addDays(7) });
const c2 = await call('POST', `/api/reflections/${ref.id}/carry`, { period_start: addDays(0), period_end: addDays(7) });
await ok('C33 고칠 점이 다음 계획으로(중복 없이)', () => {
  assert.ok(c1.plan.success_criteria.includes('예상을 20% 넉넉히')); assert.equal(c2.duplicate, true); assert.equal(c2.plan.id, c1.plan.id);
});

const ex = await call('GET', '/api/export');
await ok('C34-36 내보내기에 전 자료 포함', () => {
  assert.ok(ex.plans.length >= 2 && ex.todos.length >= 6 && ex.runs.length === 3 && ex.reflections.length === 1 && ex.plan_versions.length >= 3);
});
await ok('C57 스크립트 글자는 문자열 그대로 저장', () => assert.equal(ex.plans.find((x) => x.id === p.id).title, XSS));
await ok('C57 화면 코드에 innerHTML/eval 없음', () =>
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(fs.readFileSync('public/app.js', 'utf8'))));
const home = await fetch(base + '/');
await ok('CSP: 인라인 스크립트 차단', () => assert.ok(home.headers.get('content-security-policy').includes("script-src 'self'")));

// ===== 과제 7: 인증·소유자·5일 실험 =====
const jarA = cookie;
const as = async (jar, ...a) => { const keep = cookie; cookie = jar; const r = await call(...a); const out = { ...r, jar: cookie }; cookie = keep; return out; };
const PW_B = 'test-pass-B-' + Math.random().toString(36).slice(2);
const regB = await as('', 'POST', '/api/auth/register', { email: 'b@test.dev', password: PW_B });
const jarB = regB.jar;
await ok('C94 가입', () => assert.equal(regB.status, 200));
await ok('C98 같은 이메일 두 번 가입 불가(대소문자 무시)', async () => assert.equal((await as('', 'POST', '/api/auth/register', { email: 'A@Test.dev', password: PW_A })).status, 409));
await ok('C99 비밀번호 틀림/아이디 없음 문구 동일', async () => {
  const w = await as('', 'POST', '/api/auth/login', { email: 'a@test.dev', password: 'wrong-password-1' });
  const nx = await as('', 'POST', '/api/auth/login', { email: 'nobody@test.dev', password: 'wrong-password-1' });
  assert.equal(w.status, 401); assert.equal(nx.status, 401); assert.equal(w.error, nx.error);
});
await ok('C95 로그인', async () => assert.equal((await as('', 'POST', '/api/auth/login', { email: 'a@test.dev', password: PW_A })).status, 200));
await ok('C97 로그인 없이 자료 요청은 401', async () => { for (const u of ['/api/plans', '/api/todos', '/api/review', '/api/export']) assert.equal((await as('', 'GET', u)).status, 401); });
const dbm = await import('../db.js');
const users = await dbm.query('SELECT email, password_hash FROM users ORDER BY id');
await ok('C103 저장된 비밀번호에 원문 없음(bcrypt)', () => { assert.ok(users[0].password_hash.startsWith('$2')); assert.ok(!users[0].password_hash.includes(PW_A)); });
await ok('C104 같은 비밀번호라도 저장값이 다름', async () => {
  const x = await as('', 'POST', '/api/auth/register', { email: 'c@test.dev', password: PW_A });
  const y = await as('', 'POST', '/api/auth/register', { email: 'd@test.dev', password: PW_A });
  assert.equal(x.status, 200); assert.equal(y.status, 200);
  const r = await dbm.query("SELECT password_hash FROM users WHERE email IN ('c@test.dev','d@test.dev')");
  assert.notEqual(r[0].password_hash, r[1].password_hash);
});
const pA = (await as(jarA, 'POST', '/api/plans', { title: 'A계획', period_start: '2026-10-01', period_end: '2026-10-31', priority: 1, success_criteria: 'a', estimate_min: 10 })).plan;
const tA = (await as(jarA, 'POST', `/api/plans/${pA.id}/todos`, { title: 'A할일', estimate_min: 5 })).todo;
const pB = (await as(jarB, 'POST', '/api/plans', { title: 'B계획', period_start: '2026-10-01', period_end: '2026-10-31', priority: 1, success_criteria: 'b', estimate_min: 10 })).plan;
const tB = (await as(jarB, 'POST', `/api/plans/${pB.id}/todos`, { title: 'B할일', estimate_min: 5 })).todo;
const count = async (jar) => (await as(jar, 'GET', '/api/todos')).todos.length;
const baseA = await count(jarA), baseB = await count(jarB);
for (const [name, jar, other, planOther] of [['A→B', jarA, tB, pB], ['B→A', jarB, tA, pA]]) {
  await ok(`C117/120 ${name} 읽기 거절`, async () => assert.equal((await as(jar, 'GET', `/api/todos/${other.id}`)).status, 404));
  await ok(`C118/120 ${name} 수정 거절`, async () => assert.equal((await as(jar, 'PATCH', `/api/todos/${other.id}`, { title: '해킹' })).status, 404));
  await ok(`C119/120 ${name} 삭제 거절`, async () => assert.equal((await as(jar, 'DELETE', `/api/todos/${other.id}`)).status, 404));
  await ok(`${name} 완료·기록·계획수정·계획할일추가 거절`, async () => {
    assert.equal((await as(jar, 'POST', `/api/todos/${other.id}/complete`, {})).status, 404);
    assert.equal((await as(jar, 'POST', `/api/todos/${other.id}/runs`, { started_at: new Date().toISOString(), ended_at: new Date().toISOString() })).status, 404);
    assert.equal((await as(jar, 'PATCH', `/api/plans/${planOther.id}`, { title: '해킹' })).status, 404);
    assert.equal((await as(jar, 'GET', `/api/plans/${planOther.id}/versions`)).status, 404);
    assert.equal((await as(jar, 'POST', `/api/plans/${planOther.id}/todos`, { title: '끼워넣기' })).status, 404);
  });
}
await ok('C122 거절 뒤에도 반대편 자료 그대로', async () => {
  assert.equal(await count(jarA), baseA); assert.equal(await count(jarB), baseB);
  assert.equal((await as(jarB, 'GET', `/api/todos/${tB.id}`)).todo.title, 'B할일');
  assert.equal((await as(jarA, 'GET', `/api/todos/${tA.id}`)).todo.title, 'A할일');
});
await ok('C123 주소·헤더·본문에 남의 계정을 적어도 내 자료만', async () => {
  const r1 = await as(jarA, 'GET', '/api/todos?user_id=2&owner=b@test.dev');
  const r2 = await as(jarA, 'GET', '/api/todos', undefined, { 'X-User-Id': '2', 'X-Forwarded-User': 'b@test.dev' });
  const r3 = await as(jarA, 'POST', '/api/plans', { title: '본문주입', period_start: '2026-10-01', period_end: '2026-10-02', priority: 1, success_criteria: 'x', estimate_min: 1, user_id: 99 });
  for (const r of [r1, r2]) { assert.equal(r.todos.length, baseA); assert.ok(r.todos.some((t) => t.title === 'A할일')); assert.ok(!r.todos.some((t) => t.title === 'B할일')); }
  assert.equal((await as(jarB, 'GET', '/api/plans')).plans.some((p) => p.title === '본문주입'), false);
  assert.equal(r3.plan.user_id, undefined);
});
await ok('C125 목록에 남의 자료 없음', async () => {
  const all = JSON.stringify([await as(jarA, 'GET', '/api/plans'), await as(jarA, 'GET', '/api/todos'), await as(jarA, 'GET', '/api/runs'), await as(jarA, 'GET', '/api/review'), await as(jarA, 'GET', '/api/export')]);
  assert.ok(!all.includes('B계획') && !all.includes('B할일'));
});
await ok('남의 계획을 범위로 하는 돌아보기 거절', async () => assert.equal((await as(jarA, 'POST', '/api/reflections', { improvement: 'x', scope_plan_id: pB.id })).status, 404));
await ok('C96/C109/C110 로그아웃 뒤 같은 값·같은 요청은 401', async () => {
  const l = await as('', 'POST', '/api/auth/login', { email: 'a@test.dev', password: PW_A });
  const before = await as(l.jar, 'GET', '/api/plans');
  const lo = await as(l.jar, 'POST', '/api/auth/logout', {});
  const after = await as(l.jar, 'GET', '/api/plans');
  assert.equal(before.status, 200); assert.equal(lo.status, 200); assert.equal(after.status, 401);
});
await ok('C114 비밀번호 바꾸면 이전 세션 무효', async () => {
  const l1 = await as('', 'POST', '/api/auth/login', { email: 'b@test.dev', password: PW_B });
  const ch = await as(l1.jar, 'POST', '/api/account/password', { current_password: PW_B, new_password: PW_B + 'x' });
  assert.equal(ch.status, 200);
  assert.equal((await as(l1.jar, 'GET', '/api/plans')).status, 401);
  assert.equal((await as(jarB, 'GET', '/api/plans')).status, 401);
  assert.equal((await as(ch.jar, 'GET', '/api/plans')).status, 200);
});
await ok('CSRF: 다른 출처 Origin 거절', async () => assert.equal((await as(jarA, 'POST', '/api/plans', { title: 'x' }, { Origin: 'https://evil.example' })).status, 403));
await ok('C105/106 서버 응답에 비밀번호 원문 없음', async () => {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@test.dev', password: PW_A }) });
  const txt = (await r.text()) + JSON.stringify([...r.headers]);
  assert.ok(!txt.includes(PW_A));
});
// 5일 실험 (A 계정)
cookie = jarA;
await ok('실험: 질문 고정 후 변경 불가', async () => {
  assert.equal((await call('POST', '/api/experiment/days', { planned_min: 60, actual_min: 70 })).status, 409);
  assert.equal((await call('POST', '/api/experiment', { question: '내 예상은 얼마나 틀리나', initial_plan_rule: '예상 그대로 잡는다' })).status, 200);
  assert.equal((await call('POST', '/api/experiment', { question: '다른 질문', initial_plan_rule: 'x' })).status, 409);
});
await ok('실험: 날짜는 서버가 정함 · 같은 날 재저장은 덮어씀', async () => {
  const a = await call('POST', '/api/experiment/days', { planned_min: 60, actual_min: 90 });
  const b = await call('POST', '/api/experiment/days', { planned_min: 60, actual_min: 100, date: '2020-01-01' });
  assert.equal(b.days.length, 1); assert.equal(b.days[0].actual_min, 100); assert.equal(b.days[0].date, a.days[0].date);
});
await ok('실험: 1일차에는 규칙 변경 거절', async () => assert.equal((await call('POST', '/api/experiment/rule-change', { new_rule: 'n', reason: 'r' })).status, 409));
// 날짜를 하루씩 과거로 밀어 서로 다른 날로 만든다(테스트 전용)
const shift = async () => { await dbm.query("UPDATE diary_days SET day_date = to_char((day_date::date - 1), 'YYYY-MM-DD') WHERE user_id = (SELECT id FROM users WHERE email='a@test.dev')"); };
await shift();
await call('POST', '/api/experiment/days', { planned_min: 100, actual_min: 130 });
await ok('실험: 규칙 변경 없이는 3일차 거절', async () => { await shift(); assert.equal((await call('POST', '/api/experiment/days', { planned_min: 100, actual_min: 120 })).status, 409); });
const rc = await call('POST', '/api/experiment/rule-change', { new_rule: '예상에 20%를 더한다', reason: '매번 더 걸렸다' });
await ok('실험: 규칙 변경이 1·2일차를 가리키고 2일차 뒤에 놓임', () => {
  assert.equal(rc.rule_change.after_day1_id, rc.days[0].id); assert.equal(rc.rule_change.after_day2_id, rc.days[1].id);
  assert.ok(rc.rule_change.changed_at > rc.days[1].created_at);
});
await ok('실험: 규칙은 한 번만', async () => assert.equal((await call('POST', '/api/experiment/rule-change', { new_rule: 'n2', reason: 'r' })).status, 409));
await call('POST', '/api/experiment/days', { planned_min: 120, actual_min: 118 });
await shift(); await call('POST', '/api/experiment/days', { planned_min: 100, actual_min: 95 });
await shift(); const d5 = await call('POST', '/api/experiment/days', { planned_min: 100, actual_min: 400 });
await ok('실험: 5일 기록·튀는 값 표시·합계/평균·전후 비교', () => {
  assert.equal(d5.days.length, 5);
  assert.deepEqual(d5.days.map((d) => d.diff_min), [40, 30, -2, -5, 300]);
  assert.equal(d5.days[4].outlier, true);
  assert.equal(d5.summary.all.total_diff_min, 363); assert.equal(d5.summary.all.avg_diff_min, 73);
  assert.equal(d5.comparison.before.avg_diff_min, 35); assert.equal(d5.comparison.after.days, 3); assert.equal(d5.comparison.unit, '분');
});
await ok('실험: 6일째 거절', async () => { await shift(); assert.equal((await call('POST', '/api/experiment/days', { planned_min: 1, actual_min: 1 })).status, 409); });
await ok('C133 내보내기: 본인 자료만 + 실험 포함, 해시 없음', async () => {
  const ex2 = await call('GET', '/api/export');
  assert.equal(ex2.diary_days.length, 5); assert.ok(!JSON.stringify(ex2).includes('password_hash'));
});
await ok('C134 계정 삭제 시 자료도 삭제(비밀번호 확인 필요)', async () => {
  assert.equal((await call('DELETE', '/api/account', { password: 'wrong-wrong-wrong' })).status, 403);
  assert.equal((await call('DELETE', '/api/account', { password: PW_A })).status, 200);
  const left = await dbm.query("SELECT (SELECT count(*) FROM plans WHERE title = 'A계획') AS p, (SELECT count(*) FROM users WHERE email='a@test.dev') AS u, (SELECT count(*) FROM diary_days) AS d");
  assert.equal(Number(left[0].p), 0); assert.equal(Number(left[0].u), 0); assert.equal(Number(left[0].d), 0);
});

console.log(`\n${n} checks passed${process.exitCode ? ' (일부 실패)' : ''}`);
server.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(process.exitCode || 0);
