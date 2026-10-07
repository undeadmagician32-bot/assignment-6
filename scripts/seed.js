// 사용법: node scripts/seed.js data/my-data.json   (BASE=https://배포주소 로 원격 서버에도 넣을 수 있음)
// my-data.json 은 내가 실제로 세운 계획·할 일·기록으로 직접 채운다. 형식은 data/my-data.example.json 참고.
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:3000';
const file = process.argv[2];
if (!file) { console.error('사용법: node scripts/seed.js <json 파일>'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const call = async (m, u, b) => {
  const r = await fetch(BASE + u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(`${m} ${u}: ${j.error}`); return j;
};
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
