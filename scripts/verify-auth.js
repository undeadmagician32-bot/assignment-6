// 인증 확인 기록 생성기: 계정 두 개(임시, 무작위 비밀번호)를 만들어 실제 요청·응답을 그대로 적는다.
//   BASE=https://배포주소 node scripts/verify-auth.js [출력.md]   → 배포 서버에 요청 (끝나면 임시 계정 삭제)
//   node scripts/verify-auth.js [출력.md]                         → 메모리 DB 로 서버를 띄워 확인 (+ DB 에 저장된 비밀번호 모습)
// 기록에서 비밀번호는 ***, 세션 값은 앞 4글자만 보이고 '…생략' 으로 가린다.
import fs from 'node:fs';
import crypto from 'node:crypto';

const remote = process.env.BASE;
const outFile = process.argv[2];
let base = remote;
let dbm;
let server;
if (!remote) {
  process.env.PGLITE_DIR = 'memory://';
  const m = await import('../local-server.js');
  server = m.server;
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  dbm = await import('../db.js');
}
const logLines = [];
const log = (s = '') => { logLines.push(s); };
const rnd = () => crypto.randomBytes(9).toString('base64url');
const PW = { A: 'verify-' + rnd(), B: 'verify-' + rnd() };
const EMAIL = { A: `verify-a-${rnd().toLowerCase()}@example.invalid`, B: `verify-b-${rnd().toLowerCase()}@example.invalid` };
const jar = { A: '', B: '', none: '' };
const mask = (s) => {
  let t = typeof s === 'string' ? s : JSON.stringify(s);
  for (const p of Object.values(PW)) t = t.split(p).join('***');
  return t.replace(/(pds_session=)([A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1$2…생략');
};
const short = (cookie) => (cookie ? mask(cookie) : '(쿠키 없음)');

async function req(who, method, path, body, headers = {}, note) {
  const cookie = jar[who] || '';
  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: bodyText });
  const sc = res.headers.get('set-cookie');
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join(', ');
  log('```http');
  log(`> ${method} ${path}   [${note || who}] ${cookie ? 'Cookie: ' + short(cookie) : '(쿠키 없음)'}${extra ? ' ' + extra : ''}`);
  if (bodyText) log(`> body ${mask(bodyText)}`);
  log(`< ${res.status} ${mask(text.length > 400 ? text.slice(0, 400) + '…(생략)' : text)}`);
  if (sc) log(`< Set-Cookie: ${mask(sc)}`);
  log('```');
  return { status: res.status, data, setCookie: sc, rawCookie: sc ? sc.split(';')[0] : '' };
}
const section = (t) => { log(); log(`### ${t}`); log(); };
const setJar = (who, r) => { if (r.rawCookie) jar[who] = r.rawCookie.endsWith('=') ? '' : r.rawCookie; };
const results = [];
const check = (name, cond) => { results.push([name, !!cond]); log(`**판정: ${cond ? '통과' : '실패'}** — ${name}`); log(); };

try {
  log(`# 인증 확인 기록 (${remote ? '배포 서버' : '로컬 서버(메모리 DB)'})`);
  log(`- 대상: ${remote ? remote : '로컬 임시 서버'} · 실행 시각(UTC): ${new Date().toISOString()}`);
  log(`- 계정은 이 확인을 위해 만든 임시 계정 두 개(A, B)이며 무작위 비밀번호를 썼고, 끝에 삭제합니다. 비밀번호는 ***, 세션 값은 앞 4글자만 보이고 가렸습니다.`);

  section('0. 가입·로그인 (C94, C95, C98, C99)');
  const regA = await req('none', 'POST', '/api/auth/register', { email: EMAIL.A, password: PW.A }, {}, '계정 A 가입'); setJar('A', regA);
  const regB = await req('none', 'POST', '/api/auth/register', { email: EMAIL.B, password: PW.B }, {}, '계정 B 가입'); setJar('B', regB);
  check('두 계정 가입 성공', regA.status === 200 && regB.status === 200);
  const dup = await req('none', 'POST', '/api/auth/register', { email: EMAIL.A.toUpperCase(), password: PW.A }, {}, '같은 이메일(대문자)로 재가입');
  check('같은 이메일로 두 번 가입되지 않음(409)', dup.status === 409);
  const wrongPw = await req('none', 'POST', '/api/auth/login', { email: EMAIL.A, password: 'wrong-password-x' }, {}, '아이디는 맞고 비밀번호만 틀림');
  const noUser = await req('none', 'POST', '/api/auth/login', { email: 'nobody-' + rnd().toLowerCase() + '@example.invalid', password: 'wrong-password-x' }, {}, '아이디 자체가 없음');
  check('두 경우의 상태 코드와 안내 문구가 같음', wrongPw.status === noUser.status && wrongPw.data.error === noUser.data.error);
  const loginA = await req('none', 'POST', '/api/auth/login', { email: EMAIL.A, password: PW.A }, {}, '계정 A 로그인');
  check('만든 계정으로 로그인 성공(세션 쿠키 발급)', loginA.status === 200 && !!loginA.rawCookie);

  section('1. 각 계정에 자료 넣기 (C116)');
  const mkPlan = (t) => ({ title: t, period_start: '2026-10-01', period_end: '2026-10-31', priority: 1, success_criteria: '확인용', estimate_min: 60 });
  const pA = (await req('A', 'POST', '/api/plans', mkPlan('A의 계획'))).data.plan;
  const tA = (await req('A', 'POST', `/api/plans/${pA.id}/todos`, { title: 'A의 할 일', estimate_min: 30 })).data.todo;
  const pB = (await req('B', 'POST', '/api/plans', mkPlan('B의 계획'))).data.plan;
  const tB = (await req('B', 'POST', `/api/plans/${pB.id}/todos`, { title: 'B의 할 일', estimate_min: 30 })).data.todo;
  log(`A: 계획 #${pA.id}, 할 일 #${tA.id} / B: 계획 #${pB.id}, 할 일 #${tB.id}`); log();

  const countOf = async (who) => (await req(who, 'GET', '/api/todos', undefined, {}, `${who}의 할 일 목록(건수 확인)`)).data.todos.length;
  section('확인 ①: 로그인 없이 자료를 직접 요청 (C97, C124)');
  const own = await req('A', 'GET', `/api/todos/${tA.id}`, undefined, {}, '성공: A가 자기 할 일 읽기');
  check('성공(로그인, 자기 자료) 200', own.status === 200);
  let anon = await req('none', 'GET', `/api/todos/${tA.id}`, undefined, {}, '거절: 로그인 없음');
  const anonList = await req('none', 'GET', '/api/todos', undefined, {}, '거절: 로그인 없음(목록)');
  const anonExport = await req('none', 'GET', '/api/export', undefined, {}, '거절: 로그인 없음(내보내기)');
  check('로그인 없이 읽으면 401', anon.status === 401 && anonList.status === 401 && anonExport.status === 401);

  const before = { A: await countOf('A'), B: await countOf('B') };
  log(`**거절 시험 전 건수:** A ${before.A}건, B ${before.B}건`); log();

  const dirs = [['A', 'B', tB, pB], ['B', 'A', tA, pA]];
  section('확인 ②~④: 남의 자료 읽기·수정·삭제 — 양방향 (C117~C121)');
  for (const [me, other, ot, op] of dirs) {
    log(`#### ${me} 로그인 → ${other}의 자료 시도`); log();
    const okRead = await req(me, 'GET', `/api/todos/${(me === 'A' ? tA : tB).id}`, undefined, {}, `성공: ${me}가 자기 것 읽기`);
    const rRead = await req(me, 'GET', `/api/todos/${ot.id}`, undefined, {}, `거절 시도: ${me}가 ${other}의 것 읽기`);
    const okEdit = await req(me, 'PATCH', `/api/todos/${(me === 'A' ? tA : tB).id}`, { title: `${me}의 할 일(고침)` }, {}, `성공: ${me}가 자기 것 수정`);
    const rEdit = await req(me, 'PATCH', `/api/todos/${ot.id}`, { title: '남의 것을 고침' }, {}, `거절 시도: ${me}가 ${other}의 것 수정`);
    const rDel = await req(me, 'DELETE', `/api/todos/${ot.id}`, undefined, {}, `거절 시도: ${me}가 ${other}의 것 삭제`);
    const rPlan = await req(me, 'PATCH', `/api/plans/${op.id}`, { title: '남의 계획을 고침' }, {}, `거절 시도: ${me}가 ${other}의 계획 수정`);
    check(`${me}→${other}: 읽기·수정·삭제·계획수정이 모두 404(존재를 감춤)`, [rRead, rEdit, rDel, rPlan].every((r) => r.status === 404) && okRead.status === 200 && okEdit.status === 200);
  }
  const mineBack = { A: (await req('A', 'PATCH', `/api/todos/${tA.id}`, { title: 'A의 할 일' }, {}, 'A 자기 것 원복')).status, B: (await req('B', 'PATCH', `/api/todos/${tB.id}`, { title: 'B의 할 일' }, {}, 'B 자기 것 원복')).status };

  section('확인: 거절 앞뒤 반대편 자료 건수와 내용 (C122)');
  const after = { A: await countOf('A'), B: await countOf('B') };
  const bView = await req('B', 'GET', `/api/todos/${tB.id}`, undefined, {}, 'B가 자기 할 일 다시 읽기');
  const aView = await req('A', 'GET', `/api/todos/${tA.id}`, undefined, {}, 'A가 자기 할 일 다시 읽기');
  log(`**거절 시험 후 건수:** A ${after.A}건, B ${after.B}건 (전: A ${before.A}, B ${before.B})`); log();
  check('양쪽 건수가 같고 내용도 그대로(새로 생긴 자료 없음)', after.A === before.A && after.B === before.B && bView.data.todo.title === 'B의 할 일' && aView.data.todo.title === 'A의 할 일');

  section('확인: 주소·헤더·본문에 남의 계정을 적어 보내기 (C123)');
  const q1 = await req('A', 'GET', `/api/todos?user_id=999&owner=${encodeURIComponent(EMAIL.B)}`, undefined, {}, 'A, 주소에 B를 적음');
  const q2 = await req('A', 'GET', '/api/todos', undefined, { 'X-User-Id': '999', 'X-Forwarded-User': EMAIL.B }, 'A, 헤더에 B를 적음');
  const q3 = await req('A', 'POST', '/api/plans', { ...mkPlan('본문에 user_id 를 적은 계획'), user_id: 999, owner_email: EMAIL.B }, {}, 'A, 본문에 B를 적음');
  const bPlans = (await req('B', 'GET', '/api/plans', undefined, {}, 'B의 계획 목록')).data.plans;
  check('그래도 A의 자료만 돌아오고, 본문에 적은 계정은 무시됨(B 쪽에 생기지 않음)',
    [q1, q2].every((r) => r.data.todos.every((t) => t.title.startsWith('A')) ) && q3.status === 200 && !bPlans.some((p) => p.title.includes('본문에')));

  section('확인: 목록 응답에 남의 자료가 없음 (C125)');
  const listings = [await req('A', 'GET', '/api/plans'), await req('A', 'GET', '/api/todos'), await req('A', 'GET', '/api/runs'), await req('A', 'GET', '/api/review'), await req('A', 'GET', '/api/export')];
  check('A의 계획·할 일·기록·돌아보기·내보내기 응답 어디에도 B의 자료(B의 계획/B의 할 일)가 없음', listings.every((r) => !JSON.stringify(r.data).includes('B의 ')));

  section('확인 ⑤: 로그아웃 뒤 같은 값으로 같은 요청 (C109, C110, C115)');
  const keepCookie = jar.A;
  const okReq = await req('A', 'GET', '/api/plans', undefined, {}, '로그인 상태: 같은 주소·같은 방식');
  const lo = await req('A', 'POST', '/api/auth/logout', {}, {}, '로그아웃');
  jar.A = keepCookie; // 브라우저가 지웠더라도, 지워지기 전의 같은 값을 그대로 다시 보낸다
  const afterReq = await req('A', 'GET', '/api/plans', undefined, {}, '로그아웃 뒤: 같은 값·같은 주소·같은 방식');
  check('달라진 것은 로그아웃뿐: 200 → 401', okReq.status === 200 && lo.status === 200 && afterReq.status === 401);

  section('비밀번호를 바꾸면 이전 값이 끊김 (C114)');
  const lg = await req('none', 'POST', '/api/auth/login', { email: EMAIL.B, password: PW.B }, {}, 'B 두 번째 기기 로그인'); const oldJar = lg.rawCookie;
  const chg = await req('B', 'POST', '/api/account/password', { current_password: PW.B, new_password: PW.B + '-new' }, {}, 'B 비밀번호 변경');
  const oldSess = jar.B; jar.B = oldJar; const useOld = await req('B', 'GET', '/api/plans', undefined, {}, '이전에 발급한 값으로 요청'); jar.B = oldSess;
  const useOld2 = await req('B', 'GET', '/api/plans', undefined, {}, '변경 전 첫 세션 값으로 요청');
  PW.B = PW.B + '-new'; setJar('B', chg);
  const useNew = await req('B', 'GET', '/api/plans', undefined, {}, '변경 직후 새로 받은 값으로 요청');
  check('비밀번호 변경 뒤 이전 값은 401, 새 값은 200', chg.status === 200 && useOld.status === 401 && useOld2.status === 401 && useNew.status === 200);

  section('다른 출처에서 온 요청(CSRF) 거절');
  const csrf = await req('B', 'POST', '/api/plans', mkPlan('다른 출처에서 만든 계획'), { Origin: 'https://evil.example' }, 'B 쿠키 + 다른 출처 Origin');
  check('403 거절', csrf.status === 403);

  if (dbm) {
    section('DB 에 저장된 비밀번호 모습 (C103, C104) — 로컬 서버에서만 가능');
    const twin1 = EMAIL.A.replace('verify-a', 'twin-1'), twin2 = EMAIL.A.replace('verify-a', 'twin-2');
    const SAME = 'same-password-' + rnd();
    PW.S = SAME; // 기록에서 가려지도록 등록
    await req('none', 'POST', '/api/auth/register', { email: twin1, password: SAME }, {}, '같은 비밀번호로 계정 1');
    await req('none', 'POST', '/api/auth/register', { email: twin2, password: SAME }, {}, '같은 비밀번호로 계정 2');
    const rows = await dbm.query("SELECT email, password_hash FROM users WHERE email LIKE 'twin-%' OR email LIKE 'verify-b-%' ORDER BY id");
    log('```text'); log('SELECT email, password_hash FROM users;');
    for (const r of rows) log(`${r.email}  |  ${r.password_hash}`);
    log('```'); log();
    log(`입력한 비밀번호 글자는 어느 줄에도 없고, 같은 비밀번호로 만든 두 계정(twin-1, twin-2)의 저장값이 다릅니다. 방식: bcrypt(cost 12, 계정마다 다른 salt 가 해시 문자열에 포함).`); log();
    const tw = rows.filter((r) => r.email.startsWith('twin-'));
    check('저장값에 원문 없음 + 같은 비밀번호인데 저장값이 서로 다름', rows.every((r) => !r.password_hash.includes(SAME)) && tw.length === 2 && tw[0].password_hash !== tw[1].password_hash && tw.every((r) => r.password_hash.startsWith('$2')));
    const sess = await dbm.query('SELECT token_hash, created_at, expires_at FROM sessions ORDER BY id LIMIT 2');
    log('```text'); log('SELECT token_hash, created_at, expires_at FROM sessions LIMIT 2;  -- 세션 값 원문은 저장하지 않고 SHA-256 해시만 저장');
    for (const r of sess) log(`${r.token_hash.slice(0, 12)}…생략  |  ${r.created_at}  |  ${r.expires_at}`);
    log('```'); log();
    // 서버 로그에 비밀번호가 남는지: 이 프로세스의 console 출력은 오류 때만 쓰이며, 요청 본문은 어디에서도 기록하지 않는다.
    await req('none', 'POST', '/api/auth/login', { email: twin1, password: SAME }, {}, '정리용 로그인');
    for (const e of [twin1, twin2]) { /* 삭제는 아래 정리 단계에서 */ void e; }
  }

  section('정리: 임시 계정 삭제 (C134)');
  const delA = await req('none', 'POST', '/api/auth/login', { email: EMAIL.A, password: PW.A }, {}, 'A 다시 로그인'); setJar('A', delA);
  const wrong = await req('A', 'DELETE', '/api/account', { password: 'wrong-password-x' }, {}, '비밀번호 틀리게 삭제 시도');
  const del1 = await req('A', 'DELETE', '/api/account', { password: PW.A }, {}, 'A 계정 삭제');
  const del2 = await req('B', 'DELETE', '/api/account', { password: PW.B }, {}, 'B 계정 삭제');
  check('틀린 비밀번호는 403, 맞으면 삭제(200)', wrong.status === 403 && del1.status === 200 && del2.status === 200);
  const gone = await req('none', 'POST', '/api/auth/login', { email: EMAIL.A, password: PW.A }, {}, '삭제된 A 로그인 시도');
  check('삭제된 계정은 로그인되지 않음', gone.status === 401);

  log(); log('## 요약');
  for (const [n, o] of results) log(`- ${o ? '✅' : '❌'} ${n}`);
  const failed = results.filter(([, o]) => !o);
  log(); log(failed.length ? `**실패 ${failed.length}건**` : `**전체 ${results.length}건 통과**`);
  if (failed.length) process.exitCode = 1;
} finally {
  const text = logLines.join('\n') + '\n';
  if (outFile) fs.writeFileSync(outFile, text, 'utf8'); else console.log(text);
  if (server) server.close();
  if (outFile) console.log(`${outFile} 작성 (${results.filter(([, o]) => o).length}/${results.length} 통과)`);
  process.exit(process.exitCode || 0);
}
