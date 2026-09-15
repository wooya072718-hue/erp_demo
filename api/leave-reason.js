/* ======================================================================
   /api/leave-reason  —  휴가 반려 사유 문구를 3개 추천한다

   왜 필요한가
   ---------------------------------------------------------------------
   신입 인사담당자가 가장 막히는 지점이 "반려는 해야 하는데 뭐라고 쓰지" 다.
   너무 짧으면 무성의하고, 잘못 쓰면 감정이 상한다.
   그래서 상황을 주고 실무 톤의 후보 문장을 받아 고른 뒤 고쳐 쓰게 한다.

   받는 값 (POST, JSON)
     name dept rank   신청자
     type start end days reason   휴가 정보
     remain          남은 연차
     note            반려하려는 배경 (담당자가 직접 적음, 없어도 됨)

   돌려주는 값
     { ok:true, 모델, 후보:["...","...","..."] }

   키는 서버에만 있고 응답에 담지 않는다.
   ====================================================================== */

const { 키읽기, 생성, 보내기, 실패보내기, 키없음응답 } = require('./_gemini');

/* Vercel 은 req.body 를 만들어 주지만, 로컬에서 직접 띄웠을 때는 없을 수 있다 */
async function 본문읽기(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

/* 사람이 넣은 값이 프롬프트를 망가뜨리지 않게 길이를 자르고 줄바꿈을 없앤다 */
function 다듬기(v, 최대) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 최대 || 120);
}

function 프롬프트만들기(d) {
  const 기간 = d.start === d.end ? d.start : `${d.start} ~ ${d.end}`;
  return [
    '너는 한국 회사의 인사·총무 담당자다.',
    '아래 휴가 신청을 "반려"할 때 결재란에 적을 사유 문장을 3개 제안해라.',
    '',
    '[신청 내용]',
    `신청자: ${d.name} (${d.dept} ${d.rank})`,
    `휴가 종류: ${d.type}`,
    `기간: ${기간} (${d.days}일)`,
    `신청자가 적은 사유: ${d.reason || '(없음)'}`,
    `남은 연차: ${d.remain}일`,
    `담당자 메모(반려하려는 배경): ${d.note || '(없음)'}`,
    '',
    '[반드시 지킬 것]',
    '1. 각 문장은 한국어 한 문장, 40~90자.',
    '2. 위에 주어진 사실만 쓴다. 없는 규정·날짜·인물을 지어내지 않는다.',
    '3. 정중하되 분명하게. 신청자를 탓하거나 평가하는 표현은 쓰지 않는다.',
    '4. 가능하면 다음 행동(일정 조정 후 재신청 등)을 함께 제시한다.',
    '5. 세 문장은 서로 다른 근거나 어조여야 한다.',
    '6. 번호나 따옴표 없이 문장만 담는다.',
  ].join('\n');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return 보내기(res, 405, { ok: false, step: '요청', message: 'POST 로 보내 주세요.' });
  }

  const key = 키읽기();
  if (!key) return 키없음응답(res);

  const b = await 본문읽기(req);
  const d = {
    name: 다듬기(b.name, 20) || '신청자',
    dept: 다듬기(b.dept, 20) || '-',
    rank: 다듬기(b.rank, 20) || '-',
    type: 다듬기(b.type, 20) || '연차',
    start: 다듬기(b.start, 10),
    end: 다듬기(b.end, 10) || 다듬기(b.start, 10),
    days: Number(b.days) || 0,
    reason: 다듬기(b.reason, 100),
    remain: Number(b.remain) || 0,
    note: 다듬기(b.note, 200),
  };

  if (!d.start) {
    return 보내기(res, 400, { ok: false, step: '요청', message: '휴가 기간이 없습니다.' });
  }

  try {
    const r = await 생성(key, 프롬프트만들기(d), {
      temperature: 0.8,          /* 후보 3개가 서로 달라야 하므로 조금 높인다 */
      responseMimeType: 'application/json',
      responseSchema: { type: 'ARRAY', items: { type: 'STRING' } },
    });

    let 후보 = [];
    try {
      const parsed = JSON.parse(r.답);
      if (Array.isArray(parsed)) 후보 = parsed;
    } catch {
      /* JSON 이 아니면 줄 단위로 나눠 쓴다 */
      후보 = r.답.split('\n');
    }

    /* 앞에 붙은 목록 기호만 떼어낸다.
       "9월 18일..." 의 9 까지 지우지 않도록 뒤에 구분자가 있을 때만 지운다. */
    후보 = 후보
      .map(s => String(s).replace(/^\s*(?:[-*•]\s+|\d{1,2}[.)]\s+)/, '').trim())
      .filter(Boolean)
      .slice(0, 3);

    if (!후보.length) {
      return 보내기(res, 502, {
        ok: false, step: '문구 정리', message: '쓸 만한 문장을 만들지 못했습니다.',
      });
    }

    보내기(res, 200, { ok: true, 모델: r.모델, 후보 });
  } catch (e) {
    실패보내기(res, e);
  }
};
