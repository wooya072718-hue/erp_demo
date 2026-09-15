/* ======================================================================
   /api/gemini-test  —  Gemini API 키가 제대로 연결됐는지 확인하는 용도

   왜 서버(= 이 파일)가 필요한가
   ---------------------------------------------------------------------
   API 키를 index.html 에 넣으면 페이지를 연 사람 누구나 볼 수 있습니다.
   그래서 키는 서버 환경변수에만 두고, 브라우저는 이 주소만 부릅니다.

   - 로컬   : 같은 폴더 .env 의 GEMINI_API_KEY  (vercel dev 실행 시)
   - Vercel : 프로젝트 Settings → Environment Variables 의 GEMINI_API_KEY

   하는 일 두 가지
   1) 모델 목록을 받아온다      → 키 자체가 유효한지 (돈 안 듦)
   2) 짧은 질문을 한 번 던진다  → 실제 생성까지 되는지

   응답은 항상 JSON 이고, 키 값은 절대 돌려주지 않습니다.
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

/* 위 목록 중 몇 개까지 시도해 볼지 */
const 최대시도 = 3;

const 질문 = '인사·총무 신입에게 "연차 휴가"가 무엇인지 한 문장으로 설명해 줘.';

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

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const 시작 = Date.now();
  const key = 키읽기();

  if (!key) {
    return res.status(500).end(JSON.stringify({
      ok: false,
      step: '환경변수',
      message: 'GEMINI_API_KEY 가 설정되어 있지 않습니다.',
      hint: '로컬은 .env 파일, Vercel 은 Settings → Environment Variables 에 넣으세요.',
    }));
  }

  try {
    /* ---------- 1단계: 키가 유효한가 (모델 목록) ---------- */
    const 목록응답 = await 요청(
      `${API_ROOT}/models?pageSize=100`,
      { headers: { 'x-goog-api-key': key } },
      10000
    );

    if (!목록응답.ok) {
      return res.status(502).end(JSON.stringify({
        ok: false,
        step: '키 확인',
        message: await 오류내용(목록응답),
        hint: 목록응답.status === 400 || 목록응답.status === 403
          ? '키가 틀렸거나 Generative Language API 가 꺼져 있을 수 있습니다.'
          : '',
      }));
    }

    const 목록 = await 목록응답.json();
    const 전체 = Array.isArray(목록.models) ? 목록.models : [];

    /* 글을 생성할 수 있는 모델만 남깁니다 */
    const 쓸수있는 = 전체
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name || '').replace(/^models\//, ''));

    /* 선호 목록 중 실제로 쓸 수 있는 것만, 순서 그대로 */
    const 후보 = 선호_모델.filter(m => 쓸수있는.includes(m));
    if (!후보.length && 쓸수있는.length) 후보.push(쓸수있는[0]);

    if (!후보.length) {
      return res.status(502).end(JSON.stringify({
        ok: false,
        step: '모델 선택',
        message: '이 키로 글을 생성할 수 있는 모델이 하나도 없습니다.',
        모델수: 전체.length,
      }));
    }

    /* ---------- 2단계: 실제로 답이 오는가 (안 되면 다음 모델로) ---------- */
    const 건너뛴모델 = [];

    /* 한 모델에게 한 번 물어본다 */
    const 물어보기 = (모델, 생각끄기) => 요청(
      `${API_ROOT}/models/${encodeURIComponent(모델)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 질문 }] }],
          generationConfig: {
            maxOutputTokens: 800,
            temperature: 0.2,
            /* 최신 모델은 답하기 전에 '생각'을 하는데, 그 생각이 출력 한도를
               다 먹어 정작 답이 잘려 나옵니다. 연결 확인용이라 꺼 둡니다. */
            ...(생각끄기 ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          },
        }),
      },
      20000
    );

    for (const 모델 of 후보.slice(0, 최대시도)) {
      let 생성응답 = await 물어보기(모델, true);

      /* thinkingConfig 를 모르는 모델이면 그 옵션 없이 한 번 더 */
      if (생성응답.status === 400) {
        생성응답 = await 물어보기(모델, false);
      }

      if (!생성응답.ok) {
        건너뛴모델.push({ 모델, 이유: await 오류내용(생성응답) });
        continue;   /* 과부하·단종 등 — 다음 모델로 */
      }

      const 결과 = await 생성응답.json();
      const parts = (((결과.candidates || [])[0] || {}).content || {}).parts || [];
      const 답 = parts.map(p => p.text).filter(Boolean).join('').trim();

      if (!답) {
        건너뛴모델.push({ 모델, 이유: '답이 비어 있음' });
        continue;
      }

      return res.status(200).end(JSON.stringify({
        ok: true,
        모델,
        질문,
        답,
        쓸수있는모델수: 쓸수있는.length,
        건너뛴모델,
        걸린시간ms: Date.now() - 시작,
      }));
    }

    /* 후보를 다 써 봤는데 전부 실패 */
    return res.status(502).end(JSON.stringify({
      ok: false,
      step: '답변 생성',
      message: '시도한 모델이 모두 응답하지 못했습니다.',
      건너뛴모델,
      걸린시간ms: Date.now() - 시작,
    }));

  } catch (e) {
    const 끊김 = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return res.status(504).end(JSON.stringify({
      ok: false,
      step: '통신',
      message: 끊김 ? '응답이 너무 늦어 중단했습니다.' : String(e && e.message || e),
    }));
  }
};
