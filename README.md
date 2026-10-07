# 플랜두씨 다이어리 1

계획(Plan) → 실제 한 일(Do) → 돌아보기(See). Node 22.5+ (내장 `node:sqlite`), 외부 의존성 없음. 로그인 없음.

```
npm start                              # http://localhost:3000
node scripts/seed.js data/my-data.json # 내 계획·할 일·기록 넣기 (형식: data/my-data.example.json)
npm test                               # 임시 DB로 통과 기준 30개 점검
```

- DB 파일: `data/pds.db` (환경변수 `DB_PATH`로 변경). 배포 시 이 경로를 **영구 디스크**에 두어야 재시작 후에도 남습니다.
- 스키마·날짜/단위 규칙: `contracts/pds-schema-v2.json`
- 비밀값 없음: 환경변수는 `PORT`, `DB_PATH`뿐입니다.
