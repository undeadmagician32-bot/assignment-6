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

const call = async (m, u, b, h = {}) => {
  const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', ...h }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, ...(await r.json()) };
};
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
await ok('C82 공개 안내 문구', async () =>
  assert.ok((await home.text()).includes('지금은 로그인이 없어 링크를 아는 사람은 누구나 볼 수 있습니다. 남이 봐도 괜찮은 내용만 넣으세요')));

console.log(`\n${n} checks passed${process.exitCode ? ' (일부 실패)' : ''}`);
server.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(process.exitCode || 0);
