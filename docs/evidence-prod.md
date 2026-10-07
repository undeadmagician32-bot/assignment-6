# 인증 확인 기록 (배포 서버)
- 대상: https://assignment-6-five-sage.vercel.app · 실행 시각(UTC): 2026-10-07T11:40:34.280Z
- 계정은 이 확인을 위해 만든 임시 계정 두 개(A, B)이며 무작위 비밀번호를 썼고, 끝에 삭제합니다. 비밀번호는 ***, 세션 값은 앞 4글자만 보이고 가렸습니다.

### 0. 가입·로그인 (C94, C95, C98, C99)

```http
> POST /api/auth/register   [계정 A 가입] (쿠키 없음)
> body {"email":"verify-a-fbb3bvp9qows@example.invalid","password":"***"}
< 200 {"user":{"email":"verify-a-fbb3bvp9qows@example.invalid"}}
< Set-Cookie: pds_session=KsJg…생략; Max-Age=604800; HttpOnly; SameSite=Lax; Path=/; Secure
```
```http
> POST /api/auth/register   [계정 B 가입] (쿠키 없음)
> body {"email":"verify-b-queu3bh1ocoq@example.invalid","password":"***"}
< 200 {"user":{"email":"verify-b-queu3bh1ocoq@example.invalid"}}
< Set-Cookie: pds_session=d8qc…생략; Max-Age=604800; HttpOnly; SameSite=Lax; Path=/; Secure
```
**판정: 통과** — 두 계정 가입 성공

```http
> POST /api/auth/register   [같은 이메일(대문자)로 재가입] (쿠키 없음)
> body {"email":"VERIFY-A-FBB3BVP9QOWS@EXAMPLE.INVALID","password":"***"}
< 409 {"error":"이미 가입된 이메일입니다"}
```
**판정: 통과** — 같은 이메일로 두 번 가입되지 않음(409)

```http
> POST /api/auth/login   [아이디는 맞고 비밀번호만 틀림] (쿠키 없음)
> body {"email":"verify-a-fbb3bvp9qows@example.invalid","password":"wrong-password-x"}
< 401 {"error":"이메일 또는 비밀번호가 올바르지 않습니다"}
```
```http
> POST /api/auth/login   [아이디 자체가 없음] (쿠키 없음)
> body {"email":"nobody-ddxjjdi7_pyb@example.invalid","password":"wrong-password-x"}
< 401 {"error":"이메일 또는 비밀번호가 올바르지 않습니다"}
```
**판정: 통과** — 두 경우의 상태 코드와 안내 문구가 같음

```http
> POST /api/auth/login   [계정 A 로그인] (쿠키 없음)
> body {"email":"verify-a-fbb3bvp9qows@example.invalid","password":"***"}
< 200 {"user":{"email":"verify-a-fbb3bvp9qows@example.invalid"}}
< Set-Cookie: pds_session=j3qf…생략; Max-Age=604800; HttpOnly; SameSite=Lax; Path=/; Secure
```
**판정: 통과** — 만든 계정으로 로그인 성공(세션 쿠키 발급)


### 1. 각 계정에 자료 넣기 (C116)

```http
> POST /api/plans   [A] Cookie: pds_session=KsJg…생략
> body {"title":"A의 계획","period_start":"2026-10-01","period_end":"2026-10-31","priority":1,"success_criteria":"확인용","estimate_min":60}
< 200 {"plan":{"id":2,"title":"A의 계획","period_start":"2026-10-01","period_end":"2026-10-31","priority":1,"success_criteria":"확인용","estimate_min":60,"carried_from_reflection_id":null,"created_at":"2026-10-07T11:40:44.405Z","updated_at":"2026-10-07T11:40:44.405Z"}}
```
```http
> POST /api/plans/2/todos   [A] Cookie: pds_session=KsJg…생략
> body {"title":"A의 할 일","estimate_min":30}
< 200 {"todo":{"id":6,"plan_id":2,"title":"A의 할 일","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:45.861Z","updated_at":"2026-10-07T11:40:45.861Z","plan_title":"A의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false,"overdue":false,"active_completions":0}}
```
```http
> POST /api/plans   [B] Cookie: pds_session=d8qc…생략
> body {"title":"B의 계획","period_start":"2026-10-01","period_end":"2026-10-31","priority":1,"success_criteria":"확인용","estimate_min":60}
< 200 {"plan":{"id":3,"title":"B의 계획","period_start":"2026-10-01","period_end":"2026-10-31","priority":1,"success_criteria":"확인용","estimate_min":60,"carried_from_reflection_id":null,"created_at":"2026-10-07T11:40:47.688Z","updated_at":"2026-10-07T11:40:47.688Z"}}
```
```http
> POST /api/plans/3/todos   [B] Cookie: pds_session=d8qc…생략
> body {"title":"B의 할 일","estimate_min":30}
< 200 {"todo":{"id":7,"plan_id":3,"title":"B의 할 일","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:49.140Z","updated_at":"2026-10-07T11:40:49.140Z","plan_title":"B의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false,"overdue":false,"active_completions":0}}
```
A: 계획 #2, 할 일 #6 / B: 계획 #3, 할 일 #7


### 확인 ①: 로그인 없이 자료를 직접 요청 (C97, C124)

```http
> GET /api/todos/6   [성공: A가 자기 할 일 읽기] Cookie: pds_session=KsJg…생략
< 200 {"todo":{"id":6,"plan_id":2,"title":"A의 할 일","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:45.861Z","updated_at":"2026-10-07T11:40:45.861Z","plan_title":"A의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false,"overdue":false,"active_completions":0},"runs":[],"completions":[]}
```
**판정: 통과** — 성공(로그인, 자기 자료) 200

```http
> GET /api/todos/6   [거절: 로그인 없음] (쿠키 없음)
< 401 {"error":"로그인이 필요합니다"}
```
```http
> GET /api/todos   [거절: 로그인 없음(목록)] (쿠키 없음)
< 401 {"error":"로그인이 필요합니다"}
```
```http
> GET /api/export   [거절: 로그인 없음(내보내기)] (쿠키 없음)
< 401 {"error":"로그인이 필요합니다"}
```
**판정: 통과** — 로그인 없이 읽으면 401

```http
> GET /api/todos   [A의 할 일 목록(건수 확인)] Cookie: pds_session=KsJg…생략
< 200 {"today":"2026-10-07","sort":"due","sort_label":"마감일 빠른 순 → 우선순위 높은 순 → 등록 번호 작은 순 (마감일 없음은 맨 뒤)","todos":[{"id":6,"plan_id":2,"title":"A의 할 일","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:45.861Z","updated_at":"2026-10-07T11:40:45.861Z","plan_title":"A의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false…(생략)
```
```http
> GET /api/todos   [B의 할 일 목록(건수 확인)] Cookie: pds_session=d8qc…생략
< 200 {"today":"2026-10-07","sort":"due","sort_label":"마감일 빠른 순 → 우선순위 높은 순 → 등록 번호 작은 순 (마감일 없음은 맨 뒤)","todos":[{"id":7,"plan_id":3,"title":"B의 할 일","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:49.140Z","updated_at":"2026-10-07T11:40:49.140Z","plan_title":"B의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false…(생략)
```
**거절 시험 전 건수:** A 1건, B 1건


### 확인 ②~④: 남의 자료 읽기·수정·삭제 — 양방향 (C117~C121)

#### A 로그인 → B의 자료 시도

```http
> GET /api/todos/6   [성공: A가 자기 것 읽기] Cookie: pds_session=KsJg…생략
< 200 {"todo":{"id":6,"plan_id":2,"title":"A의 할 일","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:45.861Z","updated_at":"2026-10-07T11:40:45.861Z","plan_title":"A의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false,"overdue":false,"active_completions":0},"runs":[],"completions":[]}
```
```http
> GET /api/todos/7   [거절 시도: A가 B의 것 읽기] Cookie: pds_session=KsJg…생략
< 404 {"error":"할 일을 찾을 수 없습니다"}
```
```http
> PATCH /api/todos/6   [성공: A가 자기 것 수정] Cookie: pds_session=KsJg…생략
> body {"title":"A의 할 일(고침)"}
< 200 {"todo":{"id":6,"plan_id":2,"title":"A의 할 일(고침)","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:45.861Z","updated_at":"2026-10-07T11:40:57.980Z","plan_title":"A의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false,"overdue":false,"active_completions":0}}
```
```http
> PATCH /api/todos/7   [거절 시도: A가 B의 것 수정] Cookie: pds_session=KsJg…생략
> body {"title":"남의 것을 고침"}
< 404 {"error":"할 일을 찾을 수 없습니다"}
```
```http
> DELETE /api/todos/7   [거절 시도: A가 B의 것 삭제] Cookie: pds_session=KsJg…생략
< 404 {"error":"할 일을 찾을 수 없습니다"}
```
```http
> PATCH /api/plans/3   [거절 시도: A가 B의 계획 수정] Cookie: pds_session=KsJg…생략
> body {"title":"남의 계획을 고침"}
< 404 {"error":"계획을 찾을 수 없습니다"}
```
**판정: 통과** — A→B: 읽기·수정·삭제·계획수정이 모두 404(존재를 감춤)

#### B 로그인 → A의 자료 시도

```http
> GET /api/todos/7   [성공: B가 자기 것 읽기] Cookie: pds_session=d8qc…생략
< 200 {"todo":{"id":7,"plan_id":3,"title":"B의 할 일","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:49.140Z","updated_at":"2026-10-07T11:40:49.140Z","plan_title":"B의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false,"overdue":false,"active_completions":0},"runs":[],"completions":[]}
```
```http
> GET /api/todos/6   [거절 시도: B가 A의 것 읽기] Cookie: pds_session=d8qc…생략
< 404 {"error":"할 일을 찾을 수 없습니다"}
```
```http
> PATCH /api/todos/7   [성공: B가 자기 것 수정] Cookie: pds_session=d8qc…생략
> body {"title":"B의 할 일(고침)"}
< 200 {"todo":{"id":7,"plan_id":3,"title":"B의 할 일(고침)","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:49.140Z","updated_at":"2026-10-07T11:41:05.109Z","plan_title":"B의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false,"overdue":false,"active_completions":0}}
```
```http
> PATCH /api/todos/6   [거절 시도: B가 A의 것 수정] Cookie: pds_session=d8qc…생략
> body {"title":"남의 것을 고침"}
< 404 {"error":"할 일을 찾을 수 없습니다"}
```
```http
> DELETE /api/todos/6   [거절 시도: B가 A의 것 삭제] Cookie: pds_session=d8qc…생략
< 404 {"error":"할 일을 찾을 수 없습니다"}
```
```http
> PATCH /api/plans/2   [거절 시도: B가 A의 계획 수정] Cookie: pds_session=d8qc…생략
> body {"title":"남의 계획을 고침"}
< 404 {"error":"계획을 찾을 수 없습니다"}
```
**판정: 통과** — B→A: 읽기·수정·삭제·계획수정이 모두 404(존재를 감춤)

```http
> PATCH /api/todos/6   [A 자기 것 원복] Cookie: pds_session=KsJg…생략
> body {"title":"A의 할 일"}
< 200 {"todo":{"id":6,"plan_id":2,"title":"A의 할 일","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:45.861Z","updated_at":"2026-10-07T11:41:10.194Z","plan_title":"A의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false,"overdue":false,"active_completions":0}}
```
```http
> PATCH /api/todos/7   [B 자기 것 원복] Cookie: pds_session=d8qc…생략
> body {"title":"B의 할 일"}
< 200 {"todo":{"id":7,"plan_id":3,"title":"B의 할 일","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:49.140Z","updated_at":"2026-10-07T11:41:12.518Z","plan_title":"B의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false,"overdue":false,"active_completions":0}}
```

### 확인: 거절 앞뒤 반대편 자료 건수와 내용 (C122)

```http
> GET /api/todos   [A의 할 일 목록(건수 확인)] Cookie: pds_session=KsJg…생략
< 200 {"today":"2026-10-07","sort":"due","sort_label":"마감일 빠른 순 → 우선순위 높은 순 → 등록 번호 작은 순 (마감일 없음은 맨 뒤)","todos":[{"id":6,"plan_id":2,"title":"A의 할 일","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:45.861Z","updated_at":"2026-10-07T11:41:10.194Z","plan_title":"A의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false…(생략)
```
```http
> GET /api/todos   [B의 할 일 목록(건수 확인)] Cookie: pds_session=d8qc…생략
< 200 {"today":"2026-10-07","sort":"due","sort_label":"마감일 빠른 순 → 우선순위 높은 순 → 등록 번호 작은 순 (마감일 없음은 맨 뒤)","todos":[{"id":7,"plan_id":3,"title":"B의 할 일","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:49.140Z","updated_at":"2026-10-07T11:41:12.518Z","plan_title":"B의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false…(생략)
```
```http
> GET /api/todos/7   [B가 자기 할 일 다시 읽기] Cookie: pds_session=d8qc…생략
< 200 {"todo":{"id":7,"plan_id":3,"title":"B의 할 일","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:49.140Z","updated_at":"2026-10-07T11:41:12.518Z","plan_title":"B의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false,"overdue":false,"active_completions":0},"runs":[],"completions":[]}
```
```http
> GET /api/todos/6   [A가 자기 할 일 다시 읽기] Cookie: pds_session=KsJg…생략
< 200 {"todo":{"id":6,"plan_id":2,"title":"A의 할 일","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:45.861Z","updated_at":"2026-10-07T11:41:10.194Z","plan_title":"A의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false,"overdue":false,"active_completions":0},"runs":[],"completions":[]}
```
**거절 시험 후 건수:** A 1건, B 1건 (전: A 1, B 1)

**판정: 통과** — 양쪽 건수가 같고 내용도 그대로(새로 생긴 자료 없음)


### 확인: 주소·헤더·본문에 남의 계정을 적어 보내기 (C123)

```http
> GET /api/todos?user_id=999&owner=verify-b-queu3bh1ocoq%40example.invalid   [A, 주소에 B를 적음] Cookie: pds_session=KsJg…생략
< 200 {"today":"2026-10-07","sort":"due","sort_label":"마감일 빠른 순 → 우선순위 높은 순 → 등록 번호 작은 순 (마감일 없음은 맨 뒤)","todos":[{"id":6,"plan_id":2,"title":"A의 할 일","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:45.861Z","updated_at":"2026-10-07T11:41:10.194Z","plan_title":"A의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false…(생략)
```
```http
> GET /api/todos   [A, 헤더에 B를 적음] Cookie: pds_session=KsJg…생략 X-User-Id: 999, X-Forwarded-User: verify-b-queu3bh1ocoq@example.invalid
< 200 {"today":"2026-10-07","sort":"due","sort_label":"마감일 빠른 순 → 우선순위 높은 순 → 등록 번호 작은 순 (마감일 없음은 맨 뒤)","todos":[{"id":6,"plan_id":2,"title":"A의 할 일","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:45.861Z","updated_at":"2026-10-07T11:41:10.194Z","plan_title":"A의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false…(생략)
```
```http
> POST /api/plans   [A, 본문에 B를 적음] Cookie: pds_session=KsJg…생략
> body {"title":"본문에 user_id 를 적은 계획","period_start":"2026-10-01","period_end":"2026-10-31","priority":1,"success_criteria":"확인용","estimate_min":60,"user_id":999,"owner_email":"verify-b-queu3bh1ocoq@example.invalid"}
< 200 {"plan":{"id":4,"title":"본문에 user_id 를 적은 계획","period_start":"2026-10-01","period_end":"2026-10-31","priority":1,"success_criteria":"확인용","estimate_min":60,"carried_from_reflection_id":null,"created_at":"2026-10-07T11:41:21.406Z","updated_at":"2026-10-07T11:41:21.406Z"}}
```
```http
> GET /api/plans   [B의 계획 목록] Cookie: pds_session=d8qc…생략
< 200 {"plans":[{"id":3,"title":"B의 계획","period_start":"2026-10-01","period_end":"2026-10-31","priority":1,"success_criteria":"확인용","estimate_min":60,"carried_from_reflection_id":null,"created_at":"2026-10-07T11:40:47.688Z","updated_at":"2026-10-07T11:40:47.688Z","todo_count":1,"done_count":0,"version_count":1}]}
```
**판정: 통과** — 그래도 A의 자료만 돌아오고, 본문에 적은 계정은 무시됨(B 쪽에 생기지 않음)


### 확인: 목록 응답에 남의 자료가 없음 (C125)

```http
> GET /api/plans   [A] Cookie: pds_session=KsJg…생략
< 200 {"plans":[{"id":4,"title":"본문에 user_id 를 적은 계획","period_start":"2026-10-01","period_end":"2026-10-31","priority":1,"success_criteria":"확인용","estimate_min":60,"carried_from_reflection_id":null,"created_at":"2026-10-07T11:41:21.406Z","updated_at":"2026-10-07T11:41:21.406Z","todo_count":0,"done_count":0,"version_count":1},{"id":2,"title":"A의 계획","period_start":"2026-10-01","period_end":"2026-10-31","…(생략)
```
```http
> GET /api/todos   [A] Cookie: pds_session=KsJg…생략
< 200 {"today":"2026-10-07","sort":"due","sort_label":"마감일 빠른 순 → 우선순위 높은 순 → 등록 번호 작은 순 (마감일 없음은 맨 뒤)","todos":[{"id":6,"plan_id":2,"title":"A의 할 일","due_date":null,"priority":2,"estimate_min":30,"status":"open","completed_at":null,"deleted_at":null,"created_at":"2026-10-07T11:40:45.861Z","updated_at":"2026-10-07T11:41:10.194Z","plan_title":"A의 계획","tags":[],"run_count":0,"actual_min":0,"blocked":false…(생략)
```
```http
> GET /api/runs   [A] Cookie: pds_session=KsJg…생략
< 200 {"runs":[]}
```
```http
> GET /api/review   [A] Cookie: pds_session=KsJg…생략
< 200 {"today":"2026-10-07","timezone":"Asia/Seoul","unit":"minutes","scope":{"plan_id":null,"from":null,"to":null},"plans_in_scope":[{"id":2,"title":"A의 계획","period_start":"2026-10-01","period_end":"2026-10-31"},{"id":4,"title":"본문에 user_id 를 적은 계획","period_start":"2026-10-01","period_end":"2026-10-31"}],"planned":1,"done":0,"overdue":0,"blocked":0,"expected_min":30,"actual_min":0,"diff_min":-30}
```
```http
> GET /api/export   [A] Cookie: pds_session=KsJg…생략
< 200 {"exported_at":"2026-10-07T11:41:26.238Z","timezone":"Asia/Seoul","schema":"pds-schema-v3","owner_email":"verify-a-fbb3bvp9qows@example.invalid","notes":"날짜는 YYYY-MM-DD(서울 달력 날짜), 시각은 UTC ISO-8601, 시간 길이는 분(min). 본인 자료만 포함합니다.","plans":[{"id":2,"title":"A의 계획","period_start":"2026-10-01","period_end":"2026-10-31","priority":1,"success_criteria":"확인용","estimate_min":60,"carried_from_reflection_id":…(생략)
```
**판정: 통과** — A의 계획·할 일·기록·돌아보기·내보내기 응답 어디에도 B의 자료(B의 계획/B의 할 일)가 없음


### 확인 ⑤: 로그아웃 뒤 같은 값으로 같은 요청 (C109, C110, C115)

```http
> GET /api/plans   [로그인 상태: 같은 주소·같은 방식] Cookie: pds_session=KsJg…생략
< 200 {"plans":[{"id":4,"title":"본문에 user_id 를 적은 계획","period_start":"2026-10-01","period_end":"2026-10-31","priority":1,"success_criteria":"확인용","estimate_min":60,"carried_from_reflection_id":null,"created_at":"2026-10-07T11:41:21.406Z","updated_at":"2026-10-07T11:41:21.406Z","todo_count":0,"done_count":0,"version_count":1},{"id":2,"title":"A의 계획","period_start":"2026-10-01","period_end":"2026-10-31","…(생략)
```
```http
> POST /api/auth/logout   [로그아웃] Cookie: pds_session=KsJg…생략
> body {}
< 200 {"ok":true}
< Set-Cookie: pds_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/; Secure
```
```http
> GET /api/plans   [로그아웃 뒤: 같은 값·같은 주소·같은 방식] Cookie: pds_session=KsJg…생략
< 401 {"error":"로그인이 필요합니다"}
```
**판정: 통과** — 달라진 것은 로그아웃뿐: 200 → 401


### 비밀번호를 바꾸면 이전 값이 끊김 (C114)

```http
> POST /api/auth/login   [B 두 번째 기기 로그인] (쿠키 없음)
> body {"email":"verify-b-queu3bh1ocoq@example.invalid","password":"***"}
< 200 {"user":{"email":"verify-b-queu3bh1ocoq@example.invalid"}}
< Set-Cookie: pds_session=SbrT…생략; Max-Age=604800; HttpOnly; SameSite=Lax; Path=/; Secure
```
```http
> POST /api/account/password   [B 비밀번호 변경] Cookie: pds_session=d8qc…생략
> body {"current_password":"***","new_password":"***-new"}
< 200 {"ok":true}
< Set-Cookie: pds_session=DOa6…생략; Max-Age=604800; HttpOnly; SameSite=Lax; Path=/; Secure
```
```http
> GET /api/plans   [이전에 발급한 값으로 요청] Cookie: pds_session=SbrT…생략
< 401 {"error":"로그인이 필요합니다"}
```
```http
> GET /api/plans   [변경 전 첫 세션 값으로 요청] Cookie: pds_session=d8qc…생략
< 401 {"error":"로그인이 필요합니다"}
```
```http
> GET /api/plans   [변경 직후 새로 받은 값으로 요청] Cookie: pds_session=DOa6…생략
< 200 {"plans":[{"id":3,"title":"B의 계획","period_start":"2026-10-01","period_end":"2026-10-31","priority":1,"success_criteria":"확인용","estimate_min":60,"carried_from_reflection_id":null,"created_at":"2026-10-07T11:40:47.688Z","updated_at":"2026-10-07T11:40:47.688Z","todo_count":1,"done_count":0,"version_count":1}]}
```
**판정: 통과** — 비밀번호 변경 뒤 이전 값은 401, 새 값은 200


### 다른 출처에서 온 요청(CSRF) 거절

```http
> POST /api/plans   [B 쿠키 + 다른 출처 Origin] Cookie: pds_session=DOa6…생략 Origin: https://evil.example
> body {"title":"다른 출처에서 만든 계획","period_start":"2026-10-01","period_end":"2026-10-31","priority":1,"success_criteria":"확인용","estimate_min":60}
< 403 {"error":"허용되지 않은 출처의 요청입니다"}
```
**판정: 통과** — 403 거절


### 정리: 임시 계정 삭제 (C134)

```http
> POST /api/auth/login   [A 다시 로그인] (쿠키 없음)
> body {"email":"verify-a-fbb3bvp9qows@example.invalid","password":"***"}
< 200 {"user":{"email":"verify-a-fbb3bvp9qows@example.invalid"}}
< Set-Cookie: pds_session=fh2p…생략; Max-Age=604800; HttpOnly; SameSite=Lax; Path=/; Secure
```
```http
> DELETE /api/account   [비밀번호 틀리게 삭제 시도] Cookie: pds_session=fh2p…생략
> body {"password":"wrong-password-x"}
< 403 {"error":"현재 비밀번호가 올바르지 않습니다"}
```
```http
> DELETE /api/account   [A 계정 삭제] Cookie: pds_session=fh2p…생략
> body {"password":"***"}
< 200 {"deleted":true}
< Set-Cookie: pds_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/; Secure
```
```http
> DELETE /api/account   [B 계정 삭제] Cookie: pds_session=DOa6…생략
> body {"password":"***"}
< 200 {"deleted":true}
< Set-Cookie: pds_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/; Secure
```
**판정: 통과** — 틀린 비밀번호는 403, 맞으면 삭제(200)

```http
> POST /api/auth/login   [삭제된 A 로그인 시도] (쿠키 없음)
> body {"email":"verify-a-fbb3bvp9qows@example.invalid","password":"***"}
< 401 {"error":"이메일 또는 비밀번호가 올바르지 않습니다"}
```
**판정: 통과** — 삭제된 계정은 로그인되지 않음


## 요약
- ✅ 두 계정 가입 성공
- ✅ 같은 이메일로 두 번 가입되지 않음(409)
- ✅ 두 경우의 상태 코드와 안내 문구가 같음
- ✅ 만든 계정으로 로그인 성공(세션 쿠키 발급)
- ✅ 성공(로그인, 자기 자료) 200
- ✅ 로그인 없이 읽으면 401
- ✅ A→B: 읽기·수정·삭제·계획수정이 모두 404(존재를 감춤)
- ✅ B→A: 읽기·수정·삭제·계획수정이 모두 404(존재를 감춤)
- ✅ 양쪽 건수가 같고 내용도 그대로(새로 생긴 자료 없음)
- ✅ 그래도 A의 자료만 돌아오고, 본문에 적은 계정은 무시됨(B 쪽에 생기지 않음)
- ✅ A의 계획·할 일·기록·돌아보기·내보내기 응답 어디에도 B의 자료(B의 계획/B의 할 일)가 없음
- ✅ 달라진 것은 로그아웃뿐: 200 → 401
- ✅ 비밀번호 변경 뒤 이전 값은 401, 새 값은 200
- ✅ 403 거절
- ✅ 틀린 비밀번호는 403, 맞으면 삭제(200)
- ✅ 삭제된 계정은 로그인되지 않음

**전체 16건 통과**
