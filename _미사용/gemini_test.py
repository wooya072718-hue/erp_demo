"""
Gemini API 호출 맛보기 프로그램 (교육용)

- API 키는 같은 폴더의 .env 에서 읽습니다.
- 따로 설치할 것이 없습니다. 파이썬 기본 기능(urllib, json)만 씁니다.
- 공식 문서가 권장하는 Interactions API 를 씁니다.
  https://ai.google.dev/gemini-api/docs/get-started?hl=ko

사용법
    python gemini_test.py                        기본 질문 던져보기
    python gemini_test.py "질문 내용"             내가 쓴 질문 던지기
    python gemini_test.py --list                 쓸 수 있는 모델 보기
    python gemini_test.py --model gemini-3.8-flash "질문"    모델 골라 쓰기

참고: 공식 SDK(pip install google-genai)를 쓰면 코드가 더 짧아집니다.
      여기서는 "어떤 주소로 무엇을 보내고 무엇을 받는지"를 눈으로 보려고 직접 호출합니다.
"""

import io
import json
import os
import sys
import urllib.error
import urllib.request

# 윈도우 명령 프롬프트에서 한글이 깨지지 않게 맞춘다.
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")

BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_MODEL = "gemini-3.6-flash"   # 공식 문서와 서버가 권장하는 기본 모델
DEFAULT_PROMPT = "인사·총무 담당자가 연차 휴가를 관리할 때 자주 하는 실수 3가지를 한국어로 짧게 알려줘."


def load_api_key():
    """같은 폴더의 .env 에서 GEMINI_API_KEY 를 읽는다."""
    here = os.path.dirname(os.path.abspath(__file__))
    env_path = os.path.join(here, ".env")

    if not os.path.exists(env_path):
        sys.exit(
            ".env 파일이 없습니다.\n"
            "  1) .env.example 을 복사해 이름을 .env 로 바꾸고\n"
            "  2) https://aistudio.google.com/apikey 에서 받은 키를 붙여넣으세요."
        )

    for line in io.open(env_path, encoding="utf-8-sig"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() == "GEMINI_API_KEY":
            key = value.strip().strip('"').strip("'")
            if key:
                return key

    sys.exit(".env 안에 GEMINI_API_KEY 값이 없습니다.  형식:  GEMINI_API_KEY=여기에키")


def call_api(path, api_key, payload=None):
    """Gemini 서버에 요청을 보내고 JSON 응답을 돌려준다."""
    headers = {"x-goog-api-key": api_key}
    body = None

    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(BASE_URL + path, data=body, headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return json.loads(res.read().decode("utf-8"))

    except urllib.error.HTTPError as err:
        text = err.read().decode("utf-8", "replace")
        text = text.replace(api_key, "***API_KEY***")   # 키가 섞여 나오면 가린다
        hint = {
            400: "요청 형식이 잘못됐습니다.",
            401: "키가 없거나 잘못됐습니다.",
            403: "키에 권한이 없습니다. .env 의 키를 확인하세요.",
            404: "그런 모델이 없거나 이 계정에서 못 씁니다. --list 로 확인하세요.",
            429: "짧은 시간에 너무 많이 호출했습니다. 잠시 뒤 다시 시도하세요.",
        }.get(err.code, "")
        sys.exit("요청 실패 (HTTP %d) %s\n%s" % (err.code, hint, text[:600]))

    except urllib.error.URLError as err:
        sys.exit("서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.\n%s" % err.reason)


def list_models(api_key):
    """쓸 수 있는 모델 이름을 보여준다."""
    data = call_api("/models?pageSize=200", api_key)

    names = [
        m["name"].replace("models/", "")
        for m in data.get("models", [])
        if "generateContent" in m.get("supportedGenerationMethods", [])
    ]
    latest = [n for n in names if n.startswith("gemini-3")]

    print("최신 계열 (권장) — %d개" % len(latest))
    for name in latest:
        print("   " + name + ("   <- 기본값" if name == DEFAULT_MODEL else ""))

    print("\n전체 %d개 중 나머지는 구형입니다." % len(names))
    print("구형 모델(gemini-2.5 등)은 목록에 보여도 신규 계정에서는 막혀 있을 수 있습니다.")


def extract_answer(data):
    """응답에서 답변 텍스트만 뽑아낸다.

    응답 구조:
        steps[]  ->  type 이 "model_output" 인 항목
                 ->  content[]  ->  type 이 "text" 인 항목의 text
    (type 이 "thought" 인 항목은 모델이 혼자 생각한 내용이라 건너뛴다.)
    """
    chunks = []
    for step in data.get("steps", []):
        if step.get("type") != "model_output":
            continue
        for part in step.get("content", []):
            if part.get("type") == "text":
                chunks.append(part.get("text", ""))
    return "".join(chunks).strip()


def ask(api_key, model, prompt):
    """모델에게 질문하고 답을 출력한다."""
    print("모델 : %s" % model)
    print("질문 : %s" % prompt)
    print("-" * 60)

    data = call_api("/interactions", api_key, {"model": model, "input": prompt})

    answer = extract_answer(data)
    if answer:
        print(answer)
    else:
        print("답변이 비어 있습니다. (안전 필터에 걸렸을 수 있습니다)")
        print("status =", data.get("status"))

    usage = data.get("usage", {})
    if usage:
        print("-" * 60)
        print(
            "토큰 — 질문 %s / 답변 %s / 생각 %s / 합계 %s"
            % (
                usage.get("total_input_tokens", "?"),
                usage.get("total_output_tokens", "?"),
                usage.get("total_thought_tokens", "?"),
                usage.get("total_tokens", "?"),
            )
        )


def main():
    api_key = load_api_key()
    args = sys.argv[1:]

    if args and args[0] in ("--list", "-l"):
        list_models(api_key)
        return

    model = DEFAULT_MODEL
    if len(args) >= 2 and args[0] in ("--model", "-m"):
        model = args[1]
        args = args[2:]

    ask(api_key, model, " ".join(args) if args else DEFAULT_PROMPT)


if __name__ == "__main__":
    main()
