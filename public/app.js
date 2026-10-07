// 사용자 입력은 textContent 와 value 로만 화면에 넣는다.
const PRI = { 1: '높음', 2: '보통', 3: '낮음' };
const $app = document.getElementById('app');

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// null·배열을 글자로 찍지 않도록 걸러서 넣는다.
function put(el, ...kids) { el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false)); }

let toastTimer;
function toast(msg, err = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3500);
}

async function api(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth/')) { showAuth(); throw new Error(data.error || '로그인이 필요합니다'); }
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(e.message, true); return null; }
}

const fmtMin = (n) => `${n}분`;
const kst = (iso) => iso ? new Date(iso).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) : '';
function kstInput(iso) { // ISO(UTC) → datetime-local(서울)
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const fromKstInput = (v) => new Date(v + ':00+09:00').toISOString();
const uuid = () => crypto.randomUUID();

function route() {
  const raw = location.hash.replace(/^#/, '') || '/plans';
  const [path, qs] = raw.split('?');
  return { path, q: Object.fromEntries(new URLSearchParams(qs || '')) };
}
const go = (path, q = {}) => {
  const clean = Object.fromEntries(Object.entries(q).filter(([, v]) => v !== '' && v !== undefined && v !== null));
  const s = new URLSearchParams(clean).toString();
  const target = '#' + path + (s ? '?' + s : '');
  if (location.hash === target) render(); else location.hash = target;
};

function priSelect(name, val = 2) {
  return h('select', { name }, [1, 2, 3].map((n) => h('option', { value: n, selected: n === Number(val) }, PRI[n])));
}
const field = (label, input) => h('label', {}, label, input);
const formData = (form) => Object.fromEntries(new FormData(form));

// ---------------- 계획 ----------------
async function viewPlans() {
  const { plans } = await api('GET', '/api/plans');
  const today = (await api('GET', '/api/health')).today_seoul;
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const ok = await act(() => api('POST', '/api/plans', formData(e.target)), '계획을 저장했습니다');
    if (ok) render();
  } },
    h('h3', {}, '새 계획 세우기'),
    h('div', { class: 'row' },
      field('계획 이름', h('input', { name: 'title', required: true, maxlength: 120, size: 28 })),
      field('시작일', h('input', { name: 'period_start', type: 'date', required: true, value: today })),
      field('종료일', h('input', { name: 'period_end', type: 'date', required: true })),
      field('우선순위', priSelect('priority')),
      field('예상 시간(분)', h('input', { name: 'estimate_min', type: 'number', min: 0, required: true, value: 0 }))),
    field('성공 기준 (어떻게 되면 성공인가)', h('textarea', { name: 'success_criteria', required: true, maxlength: 500 })),
    h('button', { class: 'primary' }, '계획 저장'));

  const list = plans.map((p) => planCard(p));
  put($app, h('h2', {}, '계획'), form, ...(plans.length ? list : [h('p', { class: 'mut' }, '아직 계획이 없습니다.')]));
}

function planCard(p) {
  const hist = h('div', { class: 'hide' });
  const edit = h('div', { class: 'hide' });
  const view = h('div', {},
    h('h3', {}, `#${p.id} ${p.title}`),
    h('div', {}, `기간 ${p.period_start} ~ ${p.period_end} · 우선순위 ${PRI[p.priority]} · 예상 ${fmtMin(p.estimate_min)}`),
    h('div', {}, '성공 기준: ', p.success_criteria),
    h('div', { class: 'mut' }, `할 일 ${p.todo_count}개 (완료 ${p.done_count}) · 수정 버전 ${p.version_count}개`),
    p.carried_from_reflection_id ? h('div', { class: 'mut' }, `돌아보기 #${p.carried_from_reflection_id}에서 넘어온 계획`) : null);

  const editForm = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    const ok = await act(() => api('PATCH', `/api/plans/${p.id}`, formData(e.target)), '계획을 고쳤습니다 (처음 계획은 이력에 남아 있습니다)');
    if (ok) render();
  } },
    h('div', { class: 'row' },
      field('계획 이름', h('input', { name: 'title', value: p.title, required: true, size: 28 })),
      field('시작일', h('input', { name: 'period_start', type: 'date', value: p.period_start, required: true })),
      field('종료일', h('input', { name: 'period_end', type: 'date', value: p.period_end, required: true })),
      field('우선순위', priSelect('priority', p.priority)),
      field('예상 시간(분)', h('input', { name: 'estimate_min', type: 'number', min: 0, value: p.estimate_min, required: true }))),
    field('성공 기준', h('textarea', { name: 'success_criteria', required: true }, p.success_criteria)),
    h('button', { class: 'primary small' }, '고친 내용 저장'));
  edit.append(editForm);

  async function loadHist() {
    const { versions } = await api('GET', `/api/plans/${p.id}/versions`);
    put(hist, h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['버전', '저장 시각(서울)', '이름', '기간', '우선순위', '성공 기준', '예상'].map((x) => h('th', {}, x)))),
      h('tbody', {}, versions.map((v) => h('tr', {},
        h('td', {}, v.version === 1 ? 'v1 (처음 계획)' : `v${v.version}`), h('td', {}, kst(v.saved_at)), h('td', {}, v.title),
        h('td', {}, `${v.period_start} ~ ${v.period_end}`), h('td', {}, PRI[v.priority]), h('td', {}, v.success_criteria),
        h('td', {}, fmtMin(v.estimate_min))))))));
  }
  const toggle = (box, fn) => async () => { if (box.classList.contains('hide') && fn) await fn(); box.classList.toggle('hide'); };
  return h('div', { class: 'card', id: `plan-${p.id}` }, view,
    h('div', { class: 'row' },
      h('button', { class: 'small', onclick: toggle(edit) }, '수정'),
      h('button', { class: 'small', onclick: toggle(hist, loadHist) }, '수정 이력 보기'),
      h('a', { href: `#/todos?plan_id=${p.id}` }, '이 계획의 할 일'),
      h('a', { href: `#/review?plan_id=${p.id}` }, '돌아보기')),
    edit, hist);
}

// ---------------- 할 일 ----------------
async function viewTodos(q) {
  const [{ plans }, list] = await Promise.all([api('GET', '/api/plans'), api('GET', '/api/todos?' + new URLSearchParams(q))]);
  const planOpts = (sel, withAll) => [withAll ? h('option', { value: '' }, '모든 계획') : null,
    ...plans.map((p) => h('option', { value: p.id, selected: String(p.id) === String(sel) }, `#${p.id} ${p.title}`))];

  const filter = h('form', { class: 'card', onsubmit: (e) => { e.preventDefault(); go('/todos', formData(e.target)); } },
    h('div', { class: 'row' },
      field('계획', h('select', { name: 'plan_id' }, planOpts(q.plan_id, true))),
      field('검색 (제목·태그)', h('input', { name: 'q', value: q.q || '', type: 'search' })),
      field('상태', h('select', { name: 'status' }, [['', '전체'], ['open', '진행 중'], ['done', '완료']].map(([v, t]) => h('option', { value: v, selected: (q.status || '') === v }, t)))),
      field('우선순위', h('select', { name: 'priority' }, [h('option', { value: '' }, '전체'), ...[1, 2, 3].map((n) => h('option', { value: n, selected: String(q.priority) === String(n) }, PRI[n]))])),
      field('태그', h('input', { name: 'tag', value: q.tag || '', size: 10 })),
      field('지연', h('select', { name: 'overdue' }, [['', '전체'], ['1', '지연만']].map(([v, t]) => h('option', { value: v, selected: (q.overdue || '') === v }, t)))),
      field('막힘', h('select', { name: 'blocked' }, [['', '전체'], ['1', '막힘만']].map(([v, t]) => h('option', { value: v, selected: (q.blocked || '') === v }, t)))),
      field('정렬', h('select', { name: 'sort' }, [['due', '마감일'], ['priority', '우선순위'], ['estimate', '예상 시간'], ['newest', '최근 등록']].map(([v, t]) => h('option', { value: v, selected: list.sort === v }, t)))),
      h('input', { type: 'hidden', name: 'from', value: q.from || '' }), h('input', { type: 'hidden', name: 'to', value: q.to || '' }),
      h('button', { class: 'primary' }, '적용'), h('button', { type: 'button', onclick: () => go('/todos') }, '초기화')),
    h('p', { class: 'mut', id: 'sort-note' }, '정렬 기준: ', list.sort_label),
    h('p', { class: 'mut' }, `검색·거르기·정렬은 서버에서 처리합니다. 지연 기준일(서울): ${list.today} · 결과 ${list.todos.length}건`));

  const addForm = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    const pid = d.plan_id; delete d.plan_id;
    const ok = await act(() => api('POST', `/api/plans/${pid}/todos`, d), '할 일을 만들었습니다');
    if (ok) render();
  } },
    h('h3', {}, '할 일 추가'),
    plans.length ? h('div', { class: 'row' },
      field('계획', h('select', { name: 'plan_id' }, planOpts(q.plan_id || plans[0]?.id, false))),
      field('할 일', h('input', { name: 'title', required: true, maxlength: 200, size: 26 })),
      field('마감일', h('input', { name: 'due_date', type: 'date' })),
      field('우선순위', priSelect('priority')),
      field('태그(쉼표)', h('input', { name: 'tags', size: 14 })),
      field('예상 시간(분)', h('input', { name: 'estimate_min', type: 'number', min: 0, value: 30 })),
      h('button', { class: 'primary' }, '추가')) : h('p', {}, '먼저 계획 탭에서 계획을 만드세요.'));

  const body = h('tbody', {});
  for (const t of list.todos) body.append(...todoRows(t));
  put($app, h('h2', {}, '할 일'), filter, addForm,
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['#', '할 일', '계획', '마감', '우선순위', '태그', '예상', '실제', '상태', ''].map((x) => h('th', {}, x)))), body)),
    list.todos.length ? null : h('p', { class: 'mut' }, '조건에 맞는 할 일이 없습니다.'));
  if (q.open) document.getElementById(`todo-${q.open}`)?.scrollIntoView();
}

function todoRows(t) {
  const detailRow = h('tr', { class: 'hide' }, h('td', { colspan: 10 }));
  const editRow = h('tr', { class: 'hide' }, h('td', { colspan: 10 }));
  const status = t.status === 'done' ? h('span', { class: 'ok' }, '완료') : t.overdue ? h('span', { class: 'warn' }, '지연') : '진행 중';
  const main = h('tr', { id: `todo-${t.id}`, class: t.status === 'done' ? 'done-row' : '' },
    h('td', {}, t.id), h('td', {}, t.title, t.blocked ? h('span', { class: 'pill warn' }, ' 막힘') : null),
    h('td', {}, h('a', { href: `#/todos?plan_id=${t.plan_id}` }, `#${t.plan_id}`)),
    h('td', {}, t.due_date || '—'), h('td', {}, PRI[t.priority]), h('td', {}, t.tags.map((g) => h('span', { class: 'tag' }, g))),
    h('td', {}, fmtMin(t.estimate_min)), h('td', {}, fmtMin(t.actual_min), t.run_count ? h('span', { class: 'mut' }, ` (${t.run_count}건)`) : null),
    h('td', {}, status),
    h('td', { class: 'row' },
      t.status === 'done'
        ? h('button', { class: 'small', onclick: async () => { if (await act(() => api('POST', `/api/todos/${t.id}/reopen`), '진행 중으로 되돌렸습니다')) render(); } }, '되돌리기')
        : h('button', { class: 'small primary', onclick: async () => { if (await act(() => api('POST', `/api/todos/${t.id}/complete`, {}, { 'Idempotency-Key': uuid() }), '완료로 바꿨습니다')) render(); } }, '완료'),
      h('button', { class: 'small', onclick: () => editRow.classList.toggle('hide') }, '수정'),
      h('button', { class: 'small', onclick: async () => { if (detailRow.classList.contains('hide')) await loadDetail(t, detailRow); detailRow.classList.toggle('hide'); } }, '기록'),
      h('button', { class: 'small danger', onclick: async () => { if (confirm(`"${t.title}" 을(를) 지울까요?`) && await act(() => api('DELETE', `/api/todos/${t.id}`), '지웠습니다')) render(); } }, '삭제')));
  editRow.firstChild.append(h('form', { onsubmit: async (e) => {
    e.preventDefault();
    if (await act(() => api('PATCH', `/api/todos/${t.id}`, formData(e.target)), '할 일을 고쳤습니다')) render();
  } }, h('div', { class: 'row' },
    field('할 일', h('input', { name: 'title', value: t.title, required: true, size: 26 })),
    field('마감일', h('input', { name: 'due_date', type: 'date', value: t.due_date || '' })),
    field('우선순위', priSelect('priority', t.priority)),
    field('태그(쉼표)', h('input', { name: 'tags', value: t.tags.join(', '), size: 14 })),
    field('예상 시간(분)', h('input', { name: 'estimate_min', type: 'number', min: 0, value: t.estimate_min })),
    h('button', { class: 'primary small' }, '저장'))));
  return [main, editRow, detailRow];
}

async function loadDetail(t, row) {
  const { runs, completions, todo } = await api('GET', `/api/todos/${t.id}`);
  const box = row.firstChild;
  const now = new Date();
  const start = kstInput(new Date(now - 30 * 60000).toISOString());
  const end = kstInput(now.toISOString());
  put(box, 
    h('h3', {}, `#${todo.id} ${todo.title} — 계획 값 (예상 ${fmtMin(todo.estimate_min)}, 마감 ${todo.due_date || '없음'})`),
    h('p', { class: 'mut' }, `완료 기록 ${completions.length}건 (현재 유효 ${todo.active_completions}건) · 실행 기록은 별도 표에 저장되어 위의 계획 값을 바꾸지 않습니다.`),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['기록 #', '시작(서울)', '끝(서울)', '실제 걸린 시간', '막힌 이유'].map((x) => h('th', {}, x)))),
      h('tbody', {}, runs.length ? runs.map((r) => h('tr', {}, h('td', {}, r.id), h('td', {}, kst(r.started_at)), h('td', {}, kst(r.ended_at)), h('td', {}, fmtMin(r.actual_min)), h('td', {}, r.blocked_reason || '—')))
        : h('tr', {}, h('td', { colspan: 5, class: 'mut' }, '실행 기록이 없습니다'))))),
    h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const d = formData(e.target);
      const body = { started_at: fromKstInput(d.started), ended_at: fromKstInput(d.ended), actual_min: d.actual_min, blocked_reason: d.blocked_reason };
      if (await act(() => api('POST', `/api/todos/${t.id}/runs`, body, { 'Idempotency-Key': e.target.dataset.key }), '실행 기록을 저장했습니다')) render();
    }, 'data-key': uuid() },
      h('h3', {}, '실제로 한 일 적기'),
      h('div', { class: 'row' },
        field('시작 시각(서울)', h('input', { name: 'started', type: 'datetime-local', required: true, value: start })),
        field('끝난 시각(서울)', h('input', { name: 'ended', type: 'datetime-local', required: true, value: end })),
        field('실제 걸린 시간(분, 비우면 자동 계산)', h('input', { name: 'actual_min', type: 'number', min: 0 })),
        field('막혔던 이유(없으면 비움)', h('input', { name: 'blocked_reason', size: 30, maxlength: 500 })),
        h('button', { class: 'primary small' }, '실행 기록 저장'))),
    h('div', { class: 'row' },
      h('button', { class: 'small', onclick: () => doubleClickTest(t, box) }, '완료 연타 테스트 (같은 요청 2번)'),
      h('span', { class: 'mut', id: `dbl-${t.id}` })));
}

async function doubleClickTest(t, box) {
  const out = box.querySelector(`#dbl-${t.id}`);
  const key = uuid();
  const [a, b] = await Promise.all([1, 2].map(() => api('POST', `/api/todos/${t.id}/complete`, {}, { 'Idempotency-Key': key }).catch((e) => ({ error: e.message }))));
  const after = await api('GET', `/api/todos/${t.id}`);
  out.textContent = `응답 duplicate: ${a.duplicate}, ${b.duplicate} → 완료 기록 ${after.completions.length}건 (유효 ${after.todo.active_completions}건). 목록을 새로 불러옵니다.`;
  setTimeout(render, 1800);
}

// ---------------- 실행 기록 ----------------
async function viewRuns(q) {
  const { runs } = await api('GET', '/api/runs?' + new URLSearchParams(q));
  put($app, h('h2', {}, '실행 기록'),
    h('p', { class: 'mut' }, `각 기록은 해당 할 일에 이어져 있습니다. 합계: ${fmtMin(runs.reduce((s, r) => s + r.actual_min, 0))} · ${runs.length}건`),
    h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['기록 #', '할 일', '시작(서울)', '끝(서울)', '실제 시간', '막힌 이유'].map((x) => h('th', {}, x)))),
      h('tbody', {}, runs.map((r) => h('tr', { id: `run-${r.id}` }, h('td', {}, r.id),
        h('td', {}, h('a', { href: `#/todos?plan_id=${r.plan_id}&open=${r.todo_id}` }, `#${r.todo_id} ${r.todo_title}`)),
        h('td', {}, kst(r.started_at)), h('td', {}, kst(r.ended_at)), h('td', {}, fmtMin(r.actual_min)), h('td', {}, r.blocked_reason || '—')))))));
}

// ---------------- 돌아보기 ----------------
async function viewReview(q) {
  const scope = { plan_id: q.plan_id || '', from: q.from || '', to: q.to || '' };
  const qs = Object.fromEntries(Object.entries(scope).filter(([, v]) => v));
  const [{ plans }, r, { reflections }] = await Promise.all([api('GET', '/api/plans'), api('GET', '/api/review?' + new URLSearchParams(qs)), api('GET', '/api/reflections')]);
  const link = (extra, path = '/todos') => `#${path}?${new URLSearchParams({ ...qs, ...extra })}`;
  const tile = (n, label, href) => h('a', { class: 'stat', href }, h('b', {}, n), h('span', {}, label));

  const filter = h('form', { class: 'card', onsubmit: (e) => { e.preventDefault(); go('/review', formData(e.target)); } },
    h('div', { class: 'row' },
      field('계획', h('select', { name: 'plan_id' }, [h('option', { value: '' }, '모든 계획'), ...plans.map((p) => h('option', { value: p.id, selected: String(p.id) === scope.plan_id }, `#${p.id} ${p.title}`))])),
      field('기간 시작', h('input', { name: 'from', type: 'date', value: scope.from })),
      field('기간 끝', h('input', { name: 'to', type: 'date', value: scope.to })),
      h('button', { class: 'primary' }, '집계'), h('button', { type: 'button', onclick: () => go('/review') }, '초기화')),
    h('p', { class: 'mut' }, `기간을 주면 그 기간과 겹치는 계획에 딸린 할 일을 모읍니다. 지연 기준일(서울): ${r.today}. 시간 단위는 모두 분.`));

  const diffCls = r.diff_min > 0 ? 'warn' : r.diff_min < 0 ? 'ok' : '';
  const diffTxt = `${r.diff_min > 0 ? '+' : ''}${r.diff_min}분`;
  const stats = h('div', { class: 'grid' },
    tile(r.planned, '계획 수 (딸린 할 일, 삭제 제외)', link({})),
    tile(r.done, '완료 수', link({ status: 'done' })),
    tile(r.overdue, '지연 수 (미완료·마감 지남)', link({ overdue: '1' })),
    tile(r.blocked, '막힘 수 (막힌 이유 있음)', link({ blocked: '1' })),
    tile(fmtMin(r.expected_min), '예상 시간 합계', link({ sort: 'estimate' })),
    tile(fmtMin(r.actual_min), '실제 시간 합계 (실행 기록)', link({}, '/runs')),
    h('div', { class: 'stat' }, h('b', { class: diffCls }, diffTxt), h('span', {}, '차이 = 실제 − 예상 (+면 계획보다 더 걸림)')));

  const refForm = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    const ok = await act(() => api('POST', '/api/reflections', { ...d, scope_plan_id: scope.plan_id || null, period_from: scope.from, period_to: scope.to }), '돌아보기를 저장했습니다');
    if (ok) render();
  } },
    h('h3', {}, '돌아보기 남기기'),
    field('이번에 본 것 (계획이 어느 쪽으로 틀렸나)', h('textarea', { name: 'summary', maxlength: 1000 })),
    field('고칠 점 한 줄 → 다음 계획으로 넘길 것', h('input', { name: 'improvement', required: true, maxlength: 200, size: 60 })),
    h('button', { class: 'primary' }, '돌아보기 저장'));

  const today = r.today;
  const refList = reflections.map((f) => h('div', { class: 'card', id: `reflection-${f.id}` },
    h('div', {}, h('b', {}, `#${f.id} 고칠 점: `), f.improvement),
    f.summary ? h('div', { class: 'mut' }, f.summary) : null,
    f.carried_plan_id
      ? h('div', {}, '→ 다음 계획으로 넘어감: ', h('a', { href: `#/plans` }, `#${f.carried_plan_id} ${f.carried_plan_title}`), h('span', { class: 'mut' }, ' · ', h('a', { href: `#/todos?plan_id=${f.carried_plan_id}` }, '그 계획의 할 일')))
      : h('form', { class: 'row', onsubmit: async (e) => {
        e.preventDefault();
        if (await act(() => api('POST', `/api/reflections/${f.id}/carry`, formData(e.target)), '다음 계획으로 넘겼습니다')) go('/plans');
      } },
        field('다음 계획 시작일', h('input', { name: 'period_start', type: 'date', required: true, value: today })),
        field('종료일', h('input', { name: 'period_end', type: 'date', required: true })),
        h('button', { class: 'primary small' }, '다음 계획으로 넘기기'))));

  put($app, h('h2', {}, '돌아보기'), filter, stats,
    h('p', { class: 'mut' }, '숫자를 누르면 그 숫자가 나온 할 일·기록 목록으로 이동합니다. 대상 계획: ',
      r.plans_in_scope.length ? r.plans_in_scope.map((p) => h('a', { href: `#/todos?plan_id=${p.id}` }, `#${p.id} ${p.title} `)) : '없음'),
    refForm, h('h3', {}, '남긴 돌아보기'), ...(refList.length ? refList : [h('p', { class: 'mut' }, '아직 없습니다.')]));
}

// ---------------- 내 자료 ----------------
async function viewData() {
  const [d, plans] = await Promise.all([api('GET', '/api/export'), api('GET', '/api/plans')]);
  put($app, h('h2', {}, '내 자료'),
    h('div', { class: 'card' },
      h('p', {}, '계획·할 일·실행 기록·돌아보기 전체를 JSON 파일 하나로 내려받습니다. 서버 데이터베이스 내용 그대로입니다.'),
      h('a', { class: 'primary', href: '/api/export', download: 'plando-diary-export.json' }, h('button', { class: 'primary' }, '전체 내보내기 (JSON)'))),
    h('div', { class: 'card' }, h('h3', {}, '현재 저장된 양'),
      h('ul', {}, [['계획', d.plans.length], ['계획 수정 버전', d.plan_versions.length], ['할 일(삭제 포함)', d.todos.length], ['실행 기록', d.runs.length], ['완료 기록', d.completion_events.length], ['돌아보기', d.reflections.length]].map(([k, v]) => h('li', {}, `${k}: ${v}`)))),
    h('div', { class: 'card mut' }, '규칙: 날짜는 서울 달력 날짜(YYYY-MM-DD), 시각은 UTC 저장 후 화면에서 서울 시간으로 표시, 시간 길이는 항상 분 단위. 내 자료는 내 계정으로 로그인했을 때만 보입니다.'),
    h('h2', {}, '계정'),
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      const f = formData(e.target);
      if (await act(() => api('POST', '/api/account/password', f), '비밀번호를 바꿨습니다. 다른 기기의 로그인은 모두 풀렸습니다')) e.target.reset();
    } }, h('h3', {}, '비밀번호 바꾸기'),
      h('div', { class: 'row' },
        field('현재 비밀번호', h('input', { name: 'current_password', type: 'password', required: true, autocomplete: 'current-password' })),
        field('새 비밀번호 (10자 이상)', h('input', { name: 'new_password', type: 'password', required: true, minlength: 10, autocomplete: 'new-password' })),
        h('button', { class: 'small primary' }, '바꾸기'))),
    h('form', { class: 'card warnbox', onsubmit: async (e) => {
      e.preventDefault();
      if (!confirm('계정과 모든 자료(계획·할 일·기록·돌아보기·5일 기록)가 영구히 지워집니다. 계속할까요?')) return;
      if (await act(() => api('DELETE', '/api/account', formData(e.target)), '계정과 자료를 지웠습니다')) showAuth();
    } }, h('h3', { class: 'warn' }, '계정 삭제'),
      h('p', {}, '계정을 지우면 내 계획·할 일·실행 기록·돌아보기·5일 기록이 함께 지워지며 되돌릴 수 없습니다. 지우기 전에 위에서 내보내기를 해 두세요.'),
      h('div', { class: 'row' },
        field('비밀번호 확인', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
        h('button', { class: 'small danger' }, '계정과 자료 삭제'))));
  void plans;
}

// ---------------- 라우팅 ----------------
async function render() {
  const { path, q } = route();
  const tab = path.slice(1).split('/')[0];
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  try {
    if (path === '/todos') await viewTodos(q);
    else if (path === '/runs') await viewRuns(q);
    else if (path === '/review') await viewReview(q);
    else if (path === '/data') await viewData();
    else if (path === '/experiment') await viewExperiment();
    else await viewPlans();
  } catch (e) {
    put($app, h('p', { class: 'warn' }, '불러오지 못했습니다: ' + e.message), h('button', { onclick: render }, '다시 시도'));
  }
}
// ---------------- 5일 기록 ----------------
async function viewExperiment() {
  const d = await api('GET', '/api/experiment');
  const exp = d.experiment;
  const parts = [h('h2', {}, '5일 기록 — 계획 규칙 하나를 바꿔 보기')];
  if (!exp) {
    parts.push(h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      if (!confirm('질문과 처음 계획 규칙은 한 번 정하면 바꿀 수 없습니다. 고정할까요?')) return;
      if (await act(() => api('POST', '/api/experiment', formData(e.target)), '1일차 질문을 고정했습니다')) render();
    } }, h('h3', {}, '1일차: 질문 고정'),
      h('p', { class: 'mut' }, '관찰 지표는 "하루 계획 시간과 실제 시간의 차이(분)" 하나로 정해져 있습니다. 질문과 지금의 계획 규칙을 사람이 읽는 문장으로 한 번만 정하세요.'),
      field('이 5일 동안 답하려는 질문 한 문장', h('input', { name: 'question', required: true, maxlength: 200, size: 60 })),
      field('지금 쓰는 계획 규칙 (예: 할 일마다 예상 시간을 처음 느낌대로 잡는다)', h('input', { name: 'initial_plan_rule', required: true, maxlength: 300, size: 60 })),
      h('button', { class: 'primary' }, '질문 고정')));
    put($app, parts);
    return;
  }
  parts.push(h('div', { class: 'card' },
    h('div', {}, h('b', {}, '질문: '), exp.question),
    h('div', {}, h('b', {}, '지표: '), `${exp.metric_name} (단위: ${exp.unit})`),
    h('div', { class: 'mut' }, exp.calc_rule),
    h('details', {}, h('summary', {}, '계산 규칙(결측·중복·튀는 값·반올림·주 시작)'),
      h('ul', {}, [exp.missing_rule, exp.duplicate_rule, exp.outlier_rule, exp.rounding_rule, `주 시작 요일: ${exp.week_start}`].map((x) => h('li', {}, x)))),
    h('div', {}, h('b', {}, '처음 계획 규칙: '), exp.initial_plan_rule),
    d.rule_change ? h('div', {}, h('b', {}, '바꾼 계획 규칙: '), d.rule_change.new_rule) : null));

  const need = d.days.length;
  const blocked = need === 2 && !d.rule_change;
  parts.push(h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    if (await act(() => api('POST', '/api/experiment/days', formData(e.target)), '오늘 기록을 저장했습니다')) render();
  } }, h('h3', {}, `오늘 기록 (서울 날짜는 서버가 정합니다 · ${need}/5일 기록됨)`),
    blocked ? h('p', { class: 'warn' }, '3일차에 들어가기 전에 아래에서 계획 규칙을 하나 바꿔 기록해야 합니다.') : null,
    h('div', { class: 'row' },
      field('오늘 계획한 시간(분)', h('input', { name: 'planned_min', type: 'number', min: 0, max: 1440, required: true })),
      field('오늘 실제로 쓴 시간(분)', h('input', { name: 'actual_min', type: 'number', min: 0, max: 1440, required: true })),
      field('메모(선택)', h('input', { name: 'note', maxlength: 300, size: 30 })),
      h('button', { class: 'primary', disabled: blocked }, '저장')),
    h('p', { class: 'mut' }, '같은 날 다시 저장하면 그날 값이 바뀝니다. 5일이 모두 서로 다른 날이어야 합니다.')));

  if (need === 2 && !d.rule_change) {
    parts.push(h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      if (!confirm('계획 규칙은 한 번만 바꿀 수 있습니다. 기록할까요?')) return;
      if (await act(() => api('POST', '/api/experiment/rule-change', formData(e.target)), '계획 규칙 변경을 기록했습니다')) render();
    } }, h('h3', {}, '2일차 뒤 · 3일차 앞: 계획 규칙 하나 바꾸기'),
      field('새 계획 규칙', h('input', { name: 'new_rule', required: true, maxlength: 300, size: 60 })),
      field('바꾼 이유', h('input', { name: 'reason', required: true, maxlength: 300, size: 60 })),
      h('button', { class: 'primary' }, '규칙 변경 기록')));
  }
  if (d.rule_change) {
    const rc = d.rule_change;
    parts.push(h('div', { class: 'card' }, h('h3', {}, '계획 규칙 변경 기록'),
      h('div', {}, `변경 시각(서울): ${kst(rc.changed_at)}`), h('div', {}, '이전 규칙: ', rc.old_rule), h('div', {}, '새 규칙: ', rc.new_rule),
      h('div', {}, '이유: ', rc.reason),
      h('div', { class: 'mut' }, `근거 기록: 1일차(#${rc.after_day1_id}), 2일차(#${rc.after_day2_id}) 뒤에 기록됨`)));
  }

  parts.push(h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['일차', '날짜(서울)', '계획(분)', '실제(분)', '차이(분)', '메모', '저장 시각'].map((x) => h('th', {}, x)))),
    h('tbody', {}, d.days.length ? d.days.map((x) => h('tr', { id: `day-${x.day_no}` },
      h('td', {}, `${x.day_no}일차`), h('td', {}, x.date), h('td', {}, x.planned_min), h('td', {}, x.actual_min),
      h('td', {}, h('b', { class: x.diff_min > 0 ? 'warn' : 'ok' }, `${x.diff_min > 0 ? '+' : ''}${x.diff_min}`), x.outlier ? h('span', { class: 'pill warn' }, ' 튀는 값') : null),
      h('td', {}, x.note || '—'), h('td', {}, kst(x.updated_at))))
      : h('tr', {}, h('td', { colspan: 7, class: 'mut' }, '아직 기록이 없습니다'))))));
  const sm = d.summary;
  parts.push(h('div', { class: 'card' }, h('h3', {}, '합계·평균 (기록이 있는 날만, 단위: 분)'),
    h('div', {}, `전체 ${sm.all.days}일 · 차이 합계 ${sm.all.total_diff_min}분 · 평균 ${sm.all.avg_diff_min ?? '—'}분`),
    h('ul', {}, sm.by_week.map((w) => h('li', {}, `${w.week_start} 시작 주(월요일 기준): ${w.days}일 · 합계 ${w.total_diff_min}분 · 평균 ${w.avg_diff_min}분`)))));
  if (d.comparison) {
    const c = d.comparison;
    parts.push(h('div', { class: 'card' }, h('h3', {}, '규칙 변경 전후 비교 (같은 지표·같은 단위·같은 계산 규칙)'),
      h('div', { class: 'mut' }, `${c.metric} · 단위 ${c.unit}`),
      h('div', {}, `변경 전(1~2일차, ${c.before.days}일): 평균 ${c.before.avg_diff_min ?? '—'}분 · 합계 ${c.before.total_diff_min}분 — 규칙: ${c.before.rule}`),
      h('div', {}, `변경 후(3일차~, ${c.after.days}일): 평균 ${c.after.avg_diff_min ?? '—'}분 · 합계 ${c.after.total_diff_min}분 — 규칙: ${c.after.rule}`)));
  }
  put($app, parts);
}

// ---------------- 로그인·가입 ----------------
let me = null;
function showAuth(msg) {
  me = null;
  document.getElementById('nav').classList.add('hide');
  const bar = document.getElementById('userbar');
  bar.classList.add('hide'); put(bar);
  let mode = 'login';
  const box = h('div', { class: 'card auth' });
  const draw = () => {
    put(box, 
      h('h2', {}, mode === 'login' ? '로그인' : '가입'),
      h('p', { class: 'mut' }, '내 계획과 기록은 로그인한 나만 볼 수 있습니다.'),
      msg ? h('p', { class: 'warn', id: 'auth-msg' }, msg) : null,
      h('div', { class: 'tabs' },
        h('button', { type: 'button', class: mode === 'login' ? 'on' : '', onclick: () => { mode = 'login'; msg = ''; draw(); } }, '로그인'),
        h('button', { type: 'button', class: mode === 'register' ? 'on' : '', onclick: () => { mode = 'register'; msg = ''; draw(); } }, '가입')),
      h('form', { onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('POST', mode === 'login' ? '/api/auth/login' : '/api/auth/register', formData(e.target));
          location.hash = '#/plans';
          await boot();
        } catch (err) { msg = err.message; draw(); }
      } },
      field('이메일', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'username' })),
      field(mode === 'login' ? '비밀번호' : '비밀번호 (10자 이상)', h('input', { name: 'password', type: 'password', required: true, minlength: mode === 'login' ? undefined : 10, autocomplete: mode === 'login' ? 'current-password' : 'new-password' })),
      h('button', { class: 'primary' }, mode === 'login' ? '로그인' : '가입하고 시작')));
  };
  draw();
  put($app, box);
}

async function boot() {
  try { me = (await api('GET', '/api/me')).user; } catch { return; } // 401 이면 api() 가 로그인 화면을 띄운다
  document.getElementById('nav').classList.remove('hide');
  const bar = document.getElementById('userbar');
  bar.classList.remove('hide');
  put(bar, h('span', {}, me.email), h('button', { class: 'small', onclick: async () => {
    await act(() => api('POST', '/api/auth/logout', {}));
    showAuth();
  } }, '로그아웃'));
  render();
}
addEventListener('hashchange', () => { if (me) render(); });
boot();
