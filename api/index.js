// Vercel 서버리스 함수. vercel.json 의 rewrites 가 /api/* 를 모두 여기로 보낸다.
import { handleApi, sendJson } from '../lib/app.js';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  if (!(await handleApi(req, res, url))) sendJson(res, 404, { error: '없는 주소입니다' });
}
