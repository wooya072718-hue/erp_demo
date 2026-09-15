"""
DART 공시검색 로컬 서버 (교육용)

무엇을 하는 프로그램인가?
    1) 이 폴더의 index.html 을 브라우저에 띄워 주는 아주 작은 웹 서버
    2) 브라우저 대신 금융감독원 DART 에 공시 목록·회사 정보를 물어봐 주는 중계(proxy)

왜 중계가 필요한가?
    DART 서버는 "브라우저에서 직접 부르는 것"을 허용하지 않습니다(CORS 미허용).
    그래서 브라우저 -> 이 파이썬 서버 -> DART 순서로 물어보고 결과만 돌려줍니다.
    덤으로 API 인증키가 .env 안에만 머물고 화면(HTML)에는 노출되지 않습니다.

사용법
    python dart_server.py            서버 켜고 브라우저 자동 실행
    python dart_server.py 9000       다른 포트(9000)로 켜기
    끄기: 이 창에서 Ctrl+C

필요한 것
    .env 파일 안에  DART_API_KEY=발급받은40자리키
    키 발급: https://opendart.fss.or.kr/  (무료, 가입 후 즉시 발급)
"""

import io
import json
import os
import sys
import threading
import webbrowser
import zipfile
import xml.etree.ElementTree as ET
import urllib.error
import urllib.parse
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# 윈도우 명령 프롬프트에서 한글이 깨지지 않게 맞춘다.
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, ".cache")
CORP_XML = os.path.join(CACHE_DIR, "CORPCODE.xml")

LIST_URL = "https://opendart.fss.or.kr/api/list.json"
CORP_URL = "https://opendart.fss.or.kr/api/corpCode.xml"
COMP_URL = "https://opendart.fss.or.kr/api/company.json"

# 화면에서 넘겨받아 DART 로 그대로 전달할 수 있는 항목 (그 외는 버린다)
ALLOWED = (
    "corp_code", "bgn_de", "end_de", "last_reprt_at", "pblntf_ty",
    "pblntf_detail_ty", "corp_cls", "sort", "sort_mth", "page_no", "page_count",
)

# DART 가 돌려주는 상태코드를 사람 말로 바꾼다.
STATUS_MSG = {
    "000": "정상",
    "010": "등록되지 않은 인증키입니다. .env 의 DART_API_KEY 를 확인하세요.",
    "011": "사용할 수 없는 인증키입니다. (오픈API 이용 동의 또는 키 상태를 확인하세요)",
    "012": "접근할 수 없는 IP 입니다.",
    "013": "조회된 자료가 없습니다. 기간이나 조건을 바꿔 보세요.",
    "020": "하루 요청 한도(1만 건)를 넘었습니다. 내일 다시 시도하세요.",
    "021": "조회 가능한 개황정보가 없습니다.",
    "100": "입력값이 잘못됐습니다. 날짜 형식(YYYYMMDD)과 조건을 확인하세요.",
    "101": "부적절한 접근입니다.",
    "800": "DART 시스템 점검 중입니다.",
    "900": "정의되지 않은 오류입니다.",
    "901": "DART 원격지 서버 오류입니다.",
}

_corp_lock = threading.Lock()   # 회사 목록을 동시에 여러 번 내려받지 않도록 잠근다
_corp_cache = None              # 한 번 읽은 회사 목록을 메모리에 두고 재사용


def load_api_key():
    """같은 폴더의 .env 에서 DART_API_KEY 를 읽는다."""
    env_path = os.path.join(HERE, ".env")
    if not os.path.exists(env_path):
        sys.exit(
            ".env 파일이 없습니다.\n"
            "  1) .env.example 을 복사해 이름을 .env 로 바꾸고\n"
            "  2) https://opendart.fss.or.kr/ 에서 받은 키를 DART_API_KEY 에 붙여넣으세요."
        )
    for line in io.open(env_path, encoding="utf-8-sig"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        if name.strip() in ("DART_API_KEY", "DART-API-KEY"):
            key = value.strip().strip('"').strip("'")
            if key:
                return key
    sys.exit(".env 안에 DART_API_KEY 값이 없습니다.  형식:  DART_API_KEY=여기에키")


API_KEY = load_api_key()


def mask(text):
    """실수로 키가 섞여 나가지 않게 가린다."""
    return text.replace(API_KEY, "***API_KEY***")


def fetch(url, params, timeout=30):
    """DART 에 요청을 보내고 본문(bytes)을 돌려준다."""
    q = dict(params)
    q["crtfc_key"] = API_KEY
    req = urllib.request.Request(
        url + "?" + urllib.parse.urlencode(q),
        headers={"User-Agent": "erp-demo-study/1.0"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


# ---------------------------------------------------------------- 공시 목록
def api_list(query):
    """공시검색(list.json) 중계."""
    params = {}
    for name in ALLOWED:
        value = (query.get(name, [""])[0] or "").strip()
        if value:
            params[name] = value

    data = json.loads(fetch(LIST_URL, params).decode("utf-8"))

    status = data.get("status", "900")
    if status != "000":
        data["message"] = STATUS_MSG.get(status, data.get("message", ""))
        if status == "013":            # 자료 없음은 오류가 아니라 '빈 결과'로 다룬다
            data["total_count"] = 0
    data.setdefault("list", [])
    return data


# ---------------------------------------------------------------- 기업 개황
def api_company(query):
    """기업개황(company.json) 중계 — 대표자·설립일·주소 등 회사 기본정보."""
    code = (query.get("corp_code", [""])[0] or "").strip()
    if len(code) != 8:
        return {"status": "100", "message": "고유번호(8자리)가 필요합니다."}

    data = json.loads(fetch(COMP_URL, {"corp_code": code}).decode("utf-8"))
    status = data.get("status", "900")
    if status != "000":
        data["message"] = STATUS_MSG.get(status, data.get("message", ""))
    return data


# ---------------------------------------------------------------- 회사 검색
def corp_list():
    """DART 전체 회사 목록(고유번호)을 읽는다. 처음 한 번만 내려받아 .cache 에 둔다."""
    global _corp_cache
    if _corp_cache is not None:
        return _corp_cache

    with _corp_lock:
        if _corp_cache is not None:
            return _corp_cache

        if not os.path.exists(CORP_XML):
            print("  · 회사 고유번호 목록을 처음 한 번 내려받습니다 (약 1~2MB)…")
            raw = fetch(CORP_URL, {}, timeout=120)
            if not raw.startswith(b"PK"):
                # zip 이 아니면 오류 XML 이 온 것이다.
                text = raw.decode("utf-8", "replace")
                code = text.split("<status>")[-1].split("</status>")[0][:3]
                raise RuntimeError(STATUS_MSG.get(code, mask(text[:200])))
            if not os.path.isdir(CACHE_DIR):
                os.makedirs(CACHE_DIR)
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                with io.open(CORP_XML, "wb") as f:
                    f.write(z.read(z.namelist()[0]))
            print("  · 저장 완료: .cache/CORPCODE.xml")

        rows = []
        for el in ET.parse(CORP_XML).getroot().iter("list"):
            def text_of(tag):
                node = el.find(tag)
                return (node.text or "").strip() if node is not None else ""
            rows.append({
                "corp_code": text_of("corp_code"),
                "corp_name": text_of("corp_name"),
                "stock_code": text_of("stock_code"),
            })
        _corp_cache = rows
        print("  · 회사 %d곳을 읽었습니다." % len(rows))
        return rows


def api_corp(query):
    """회사 이름(또는 종목코드)으로 고유번호(corp_code)를 찾는다."""
    q = (query.get("q", [""])[0] or "").strip()
    if len(q) < 2:
        return {"status": "100", "message": "회사명을 두 글자 이상 입력하세요.", "list": []}

    rows = corp_list()
    hits = [r for r in rows if q in r["corp_name"] or (q.isdigit() and q == r["stock_code"])]
    # 상장사(종목코드 있음)를 앞에, 이름이 짧은(=더 정확히 맞는) 쪽을 먼저 보여준다.
    hits.sort(key=lambda r: (not r["stock_code"], len(r["corp_name"])))
    return {"status": "000", "message": "정상", "total": len(hits), "list": hits[:30]}


# ---------------------------------------------------------------- 웹 서버
class Handler(SimpleHTTPRequestHandler):

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        path, _, qs = self.path.partition("?")
        if path.startswith("/api/dart/"):
            return self.handle_api(path, urllib.parse.parse_qs(qs))
        return SimpleHTTPRequestHandler.do_GET(self)

    def handle_api(self, path, query):
        try:
            if path == "/api/dart/list":
                body = api_list(query)
            elif path == "/api/dart/corp":
                body = api_corp(query)
            elif path == "/api/dart/company":
                body = api_company(query)
            else:
                return self.send_json({"status": "404", "message": "없는 주소입니다.", "list": []}, 404)
            return self.send_json(body)

        except urllib.error.HTTPError as err:
            text = mask(err.read().decode("utf-8", "replace"))[:300]
            self.send_json({"status": str(err.code), "list": [],
                            "message": "DART 응답 오류 (HTTP %d) %s" % (err.code, text)}, 502)
        except urllib.error.URLError as err:
            self.send_json({"status": "net", "list": [],
                            "message": "DART 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요. (%s)" % err.reason}, 502)
        except Exception as err:                      # 그 밖의 모든 오류
            self.send_json({"status": "err", "message": mask(str(err)), "list": []}, 500)

    def send_json(self, obj, code=200):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.cors()
        self.end_headers()
        self.wfile.write(raw)

    def cors(self):
        # index.html 을 파일로 바로 열었을 때(file://)도 부를 수 있게 허용한다.
        self.send_header("Access-Control-Allow-Origin", "*")

    def log_message(self, fmt, *args):
        # 그림·CSS 요청까지 다 찍으면 시끄러우므로 API 호출만 남긴다.
        line = args[0] if args else ""
        if "/api/dart/" in str(line):
            sys.stderr.write("  · %s\n" % mask(str(line)))


def main():
    port = 8000
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port = int(sys.argv[1])

    url = "http://localhost:%d/index.html" % port
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=HERE))
    except OSError as err:
        sys.exit("%d번 포트를 열지 못했습니다. (%s)\n다른 포트로 켜 보세요:  python dart_server.py 9000"
                 % (port, err))

    print("=" * 62)
    print(" 한빛상사 교육용 ERP + DART 공시검색 서버")
    print("=" * 62)
    print(" 주소 : %s" % url)
    print(" 끄기 : 이 창에서 Ctrl+C")
    print(" 키   : .env 의 DART_API_KEY (…%s) 를 씁니다" % API_KEY[-4:])
    print("=" * 62)

    try:
        webbrowser.open(url)
    except Exception:
        pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 껐습니다.")
        server.server_close()


if __name__ == "__main__":
    main()
