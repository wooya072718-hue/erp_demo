/* ======================================================================
   api/_gemini.js — Gemini 호출 공용 부분

   파일 이름이 밑줄(_)로 시작하면 Vercel 이 주소로 만들지 않습니다.
   즉 이 파일은 밖에서 부를 수 없고, 같은 폴더의 다른 함수만 가져다 씁니다.

   키는 서버 환경변수에만 있고, 어떤 경우에도 응답에 담지 않습니다.
   ====================================================================== */

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

/* 이 순서대로 시도합니다. 한 모델이 "지금 몰려서 안 된다"거나 "더 이상 못 쓴다"고
   하면 다음 것으로 넘어갑니다. (모델 이름은 수시로 바뀌므로 하나에만 기대지 않습니다) */
const 선호_모델 = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-flash-latest',
];

const 최대시도 = 3;

/* 환경변수 이름이 밑줄(GEMINI_API_KEY)인 게 표준이지만,
   하이픈(GEMINI-API-KEY)으로 적어 둔 경우도 있어 둘 다 받아 줍니다. */
function 키읽기() {
  return (
    process.env.GEMINI_API_KEY ||
    process.env['GEMINI-API-KEY'] ||
    ''
  ).trim();
}

/* 응답이 오래 걸리면 끊습니다 (Vercel 무료 플랜 실행시간 보호) */
async function 요청(url, options, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* 구글이 돌려주는 오류 메시지에서 사람이 읽을 부분만 꺼냅니다 */
async function 오류내용(res) {
  try {
    const j = await res.json();
    return (j && j.error && j.error.message) || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/* 실패를 한 덩어리로 넘기기 위한 오류 타입 */
class 제미나이오류 extends Error {
  constructor(step, message, extra) {
    super(message);
    this.step = step;
    this.extra = extra || {};
  }
}

/* 이 키로 글을 생성할 수 있는 모델 목록 */
async function 모델목록(key) {
  const res = await 요청(`${API_ROOT}/models?pageSize=100`, {
    headers: { 'x-goog-api-key': key },
  }, 10000);

  if (!res.ok) {
    throw new 제미나이오류('키 확인', await 오류내용(res), {
      hint: (res.status === 400 || res.status === 403)
        ? '키가 틀렸거나 Generative Language API 가 꺼져 있을 수 있습니다.'
        : '',
    });
  }

  const j = await res.json();
  const 전체 = Array.isArray(j.models) ? j.models : [];
  const 쓸수있는 = 전체
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name || '').replace(/^models\//, ''));

  return { 전체수: 전체.length, 쓸수있는 };
}

/* 질문 하나를 던져 답을 받아 옵니다.
   - 모델이 과부하거나 단종이면 다음 후보로 자동으로 넘어갑니다.
   - 설정으로 generationConfig 를 덧붙일 수 있습니다(JSON 출력 등). */
async function 생성(key, 프롬프트, 설정) {
  const { 전체수, 쓸수있는 } = await 모델목록(key);

  const 후보 = 선호_모델.filter(m => 쓸수있는.includes(m));
  if (!후보.length && 쓸수있는.length) 후보.push(쓸수있는[0]);
  if (!후보.length) {
    throw new 제미나이오류('모델 선택',
      '이 키로 글을 생성할 수 있는 모델이 하나도 없습니다.', { 모델수: 전체수 });
  }

  const 물어보기 = (모델, 생각끄기) => 요청(
    `${API_ROOT}/models/${encodeURIComponent(모델)}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 프롬프트 }] }],
        generationConfig: {
          maxOutputTokens: 800,
          temperature: 0.2,
          /* 최신 모델은 답하기 전에 '생각'을 하는데, 그 생각이 출력 한도를
             다 먹어 정작 답이 잘려 나옵니다. 그래서 꺼 둡니다. */
          ...(생각끄기 ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          ...(설정 || {}),
        },
      }),
    },
    20000
  );

  const 건너뛴모델 = [];

  for (const 모델 of 후보.slice(0, 최대시도)) {
    let res = await 물어보기(모델, true);

    /* thinkingConfig 를 모르는 모델이면 그 옵션 없이 한 번 더 */
    if (res.status === 400) res = await 물어보기(모델, false);

    if (!res.ok) {
      건너뛴모델.push({ 모델, 이유: await 오류내용(res) });
      continue;
    }

    const j = await res.json();
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    const 답 = parts.map(p => p.text).filter(Boolean).join('').trim();

    if (!답) {
      건너뛴모델.push({ 모델, 이유: '답이 비어 있음' });
      continue;
    }

    return { 모델, 답, 건너뛴모델, 쓸수있는모델수: 쓸수있는.length };
  }

  throw new 제미나이오류('답변 생성',
    '시도한 모델이 모두 응답하지 못했습니다.', { 건너뛴모델 });
}

/* 응답을 JSON 으로 내보내는 짧은 도우미 */
function 보내기(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

/* 키가 없거나 통신이 막혔을 때의 응답을 한곳에서 처리합니다 */
function 실패보내기(res, e) {
  if (e instanceof 제미나이오류) {
    return 보내기(res, 502, { ok: false, step: e.step, message: e.message, ...e.extra });
  }
  const 끊김 = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
  return 보내기(res, 504, {
    ok: false,
    step: '통신',
    message: 끊김 ? '응답이 너무 늦어 중단했습니다.' : String((e && e.message) || e),
  });
}

/* 키가 없으면 안내를 보내고 false 를 돌려줍니다 */
function 키없음응답(res) {
  보내기(res, 500, {
    ok: false,
    step: '환경변수',
    message: 'GEMINI_API_KEY 가 설정되어 있지 않습니다.',
    hint: '로컬은 .env 파일, Vercel 은 Settings → Environment Variables 에 넣으세요.',
  });
}

module.exports = { 키읽기, 생성, 보내기, 실패보내기, 키없음응답, 제미나이오류 };
