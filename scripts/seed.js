// 사용법: SEED_EMAIL=내@메일 SEED_PASSWORD=내비밀번호 BASE=https://배포주소 node scripts/seed.js data/my-data.json
// 로그인한 내 계정에 계획·할 일·기록을 넣는다(이미 같은 이름의 계획이 있으면 건너뜀). 비밀번호는 환경변수로만 받는다.
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:3000';
const { SEED_EMAIL, SEED_PASSWORD } = process.env;
const file = process.argv[2];
if (!file || !SEED_EMAIL || !SEED_PASSWORD) { console.error('사용법: SEED_EMAIL=… SEED_PASSWORD=… node scripts/seed.js <json 파일>'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
let cookie = '';
const call = async (m, u, b) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const j = await r.json(); if (!r.ok) throw new Error(`${m} ${u}: ${j.error}`); return j;
};
await call('POST', '/api/auth/login', { email: SEED_EMAIL, password: SEED_PASSWORD });
const kst = (s) => new Date(s + ':00+09:00').toISOString(); // 'YYYY-MM-DDTHH:mm' (서울) → UTC ISO
const existing = new Set((await call('GET', '/api/plans')).plans.map((x) => x.title));
for (const p of data.plans) {
  if (existing.has(p.title)) { console.log('건너뜀(같은 이름의 계획이 이미 있음):', p.title); continue; }
  const { todos = [], ...plan } = p;
  const { plan: made } = await call('POST', '/api/plans', plan);
  for (const t of todos) {
    const { runs = [], done, ...todo } = t;
    const { todo: mt } = await call('POST', `/api/plans/${made.id}/todos`, todo);
    for (const r of runs) await call('POST', `/api/todos/${mt.id}/runs`, { started_at: kst(r.start), ended_at: kst(r.end), actual_min: r.actual_min, blocked_reason: r.blocked_reason || '' });
    if (done) await call('POST', `/api/todos/${mt.id}/complete`);
  }
  console.log('계획 저장:', made.id, made.title, `(할 일 ${todos.length}개)`);
}
