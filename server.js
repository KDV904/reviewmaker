// server.js
// ----------------------------------------------------
// 기본 설정
// ----------------------------------------------------
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const path = require("path");
const { OpenAI } = require("openai");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public"))); // public/index.html 정적 서빙

// OpenAI API 키는 환경변수에서 읽습니다 (프론트에 절대 넣지 마세요)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------
// 전처리: 리스트/불릿 마커 제거
// ---------------------------------------------
function stripLeadMarker(s) {
  return (s || "")
    .trim()
    .replace(
      /^\s*(?:\d+\s*[\.\-\)]|[\-\*\u2022\u00B7\u2219]|[①-⑨]|[❶-❾])\s*/u,
      ""
    )
    .replace(/^\s*[\)\]]\s+/, "");
}

// ---------------------------------------------
// 후처리: 종결 꼬임/중복, 이모지 뒤 텍스트 제거 등
// ---------------------------------------------
function normalizeEnding(s) {
  if (!s) return s;
  let out = s.trim();

  // 요요/다요/음요 등 반복 종결 정리
  out = out
    .replace(/(요)(\s*요)+$/u, "$1")
    .replace(/(다)(\s*요)+$/u, "다")
    .replace(/(음)(\s*요)+$/u, "음")
    .replace(/(습니다)(\s*요)+$/u, "습니다")
    .replace(/(어요)(\s*요)+$/u, "어요")
    .replace(/(요|다|음|습니다|어요)(\s*\1)+$/u, "$1");

  // 이모지 뒤에 뭔가 붙으면 이모지까지만 남기기
  out = out.replace(
    /([\p{Emoji_Presentation}\p{Extended_Pictographic}])\s*.+$/u,
    "$1"
  );

  // 느낌표 4개 이상 → 최대 3개
  out = out.replace(/!{4,}$/u, "!!!");

  // "…다." 같은 마침표 제거 (이모지 규칙과 충돌 방지)
  out = out.replace(/(습니다|어요|다|음)\.\s*$/u, "$1");

  return out.trim();
}

// ---------------------------------------------
// 내용기반 이모지 후보 선택
// ---------------------------------------------
function pickContextEmojis(text) {
  const dict = [
    {
      rx: /(와인|wine|소믈리에|레드|화이트|스파클링)/i,
      pool: ["🍷", "🥂", "🍾"],
    },
    {
      rx: /(맥주|beer|생맥|하이볼|칵테일|바틀)/i,
      pool: ["🍺", "🍻", "🥃", "🍸"],
    },
    { rx: /(커피|라떼|에스프레소|카페|아메리카노)/i, pool: ["☕", "🧋", "🍰"] },
    {
      rx: /(디저트|케이크|빵|마카롱|달달|디저)/i,
      pool: ["🍰", "🧁", "🍩", "🍪"],
    },
    { rx: /(고기|스테이크|한우|삼겹|구이)/i, pool: ["🥩", "🍖", "🍗"] },
    {
      rx: /(해산물|회|초밥|스시|물회|오마카세)/i,
      pool: ["🍣", "🦐", "🦑", "🐟"],
    },
    { rx: /(매움|맵|매콤|얼큰)/i, pool: ["🌶️", "🔥"] },
    { rx: /(양 많|푸짐|포션|든든)/i, pool: ["🍽️", "🫶"] },
    {
      rx: /(테라스|야외|뷰|전망|루프탑|풍경)/i,
      pool: ["✨", "🌇", "🌃", "🌿"],
    },
    { rx: /(분위기|무드|아늑|감성|조명)/i, pool: ["✨", "🕯️", "🎶"] },
    { rx: /(친절|응대|서비스|사장님|직원)/i, pool: ["😊", "🤗", "🫶", "👍"] },
    { rx: /(빨리|빠르|서빙|대기 없|웨이팅 없|금방)/i, pool: ["⚡", "👍"] },
    { rx: /(예약|자리|좌석|대기)/i, pool: ["📅", "✅"] },
    { rx: /(청결|깨끗|위생|깔끔)/i, pool: ["✨", "🧼", "🧽"] },
    { rx: /(가격|가성비|비싸|저렴)/i, pool: ["💸", "👍"] },
    { rx: /(파티|생일|기념일|모임|단체)/i, pool: ["🎉", "🎂", "🎈"] },
    { rx: /(주차|발렛|파킹)/i, pool: ["🅿️", "🚗"] },
    { rx: /(아이|키즈|가족|유모차)/i, pool: ["👶", "👨‍👩‍👧‍👦"] },
    { rx: /(반려견|펫|강아지|고양이)/i, pool: ["🐶", "🐱", "🐾"] },
    { rx: /(배달|포장|테이크아웃)/i, pool: ["📦", "🏍️"] },
  ];

  const hits = dict.filter(({ rx }) => rx.test(text));
  if (hits.length === 0) return [];

  const pickFrom = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const pools = hits.map((h) => pickFrom(h.pool));
  return Array.from(new Set(pools)).slice(0, 2); // 최대 2개
}

// ---------------------------------------------
// 이모지 부착 (문장 끝 단독) + 폴백 확률
// ---------------------------------------------
function appendContextEmojisAtEnd(
  s,
  { enable = true, fallbackProb = 0.35 } = {}
) {
  if (!enable) return s;
  let out = s.trim();

  // 이미 이모지로 끝나면 그대로
  if (/[\p{Emoji_Presentation}\p{Extended_Pictographic}]$/u.test(out))
    return out;

  // 내용기반 이모지 추출
  let emos = pickContextEmojis(out);

  // 내용 키워드 없으면 확률적으로 일반 이모지 1개
  if (emos.length === 0 && Math.random() < fallbackProb) {
    const fallback = ["🙂", "😊", "👍", "🙌", "✨", "😋", "🫶", "👌"];
    emos = [fallback[Math.floor(Math.random() * fallback.length)]];
  }

  if (emos.length) {
    // 이모지 앞뒤 마침표 금지 → 문장 끝 마침표 제거
    out = out.replace(/\.\s*$/u, "");
    out += emos.slice(0, 2).join("");
  }
  return out;
}

// ---------------------------------------------
// 이모지 앞뒤 마침표 정리 (문장 내부 마침표는 유지)
// ---------------------------------------------
function cleanEmojiPlacement(s) {
  if (!s) return s;
  let out = s.trim();

  // 이모지 앞의 마침표 제거: "... .😊" → "...😊"
  out = out.replace(
    /\.([\p{Emoji_Presentation}\p{Extended_Pictographic}])/gu,
    "$1"
  );

  // 이모지 뒤의 마침표 제거: "😊." → "😊"
  out = out.replace(
    /([\p{Emoji_Presentation}\p{Extended_Pictographic}])\./gu,
    "$1"
  );

  // 끝이 ".이모지" 인 경우 마침표 제거
  out = out.replace(
    /\.([\p{Emoji_Presentation}\p{Extended_Pictographic}])$/u,
    "$1"
  );

  // 같은 이모지 여러 번 반복 → 하나만 남김
  out = out.replace(
    /([\p{Emoji_Presentation}\p{Extended_Pictographic}])\1+/gu,
    "$1"
  );

  return out.trim();
}
// ---------------------------------------------
// 이모지 총량/분산 제어 유틸
// ---------------------------------------------
const EMOJI_RE_G = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu; // replace용(전역)
const EMOJI_RE_T = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u; // test용(비전역)

const hasEmoji = (s = "") => EMOJI_RE_T.test(s);
const stripEmojis = (s = "") =>
  (s || "")
    .replace(EMOJI_RE_G, "")
    .replace(/\s{2,}/g, " ")
    .trim();

/**
 * lines: 문자열 배열
 * 옵션:
 *  - minPct/maxPct : 전체 N 대비 이모지 포함 라인 목표 비율(기본 12~18%)
 *  - minAbs/maxAbs : 절대 개수 범위로 강제하고 싶을 때(선택)
 *  - maxRun        : 최대 연속 허용 길이(기본 2)
 *  - minGapAfterDouble : 길이 2짜리 연속 블럭 다음에 필요한 최소 공백 라인 수(기본 2)
 */
function enforceEmojiQuotaAndSpread(
  lines = [],
  {
    minPct = 0.12,
    maxPct = 0.18,
    minAbs = null,
    maxAbs = null,
    maxRun = 2,
    minGapAfterDouble = 2,
  } = {}
) {
  const n = lines.length;
  const idxWithEmoji = [];
  lines.forEach((t, i) => {
    if (hasEmoji(t)) idxWithEmoji.push(i);
  });

  if (idxWithEmoji.length === 0) return lines; // 원래 이모지가 없으면 그대로

  // 1) 타겟 개수 계산
  let lo = minAbs ?? Math.floor(n * minPct);
  let hi = maxAbs ?? Math.ceil(n * maxPct);
  if (hi < lo) hi = lo;
  let target = Math.floor(lo + Math.random() * (hi - lo + 1));
  target = Math.min(target, idxWithEmoji.length); // 실제 보유 수를 초과하지 않도록

  if (target <= 0) return lines.map(stripEmojis);

  // 2) 분산 선택(이상적인 간격으로 슬롯 만들고, 가장 가까운 후보를 고름)
  const keep = new Set();
  const used = new Set();

  // 러닝 제약 체크 함수
  const okWithRuns = (candidate) => {
    if (keep.size === 0) return true;
    const kept = [...keep].sort((a, b) => a - b);
    const last = kept[kept.length - 1];

    // (a) 최대 연속 길이 제한
    if (candidate === last + 1) {
      // 직전이 1개 연속인지 확인
      const prev = kept[kept.length - 2];
      if (prev === last - 1 && maxRun <= 2) return false; // 3연속 방지
    }

    // (b) 2개 블럭 반복 패턴 방지: 직전 블럭이 길이 2였으면 최소 공백 확보
    // 최근 블럭 길이 계산
    let runLen = 1;
    let p = last - 1;
    while (kept.includes(p)) {
      runLen++;
      p--;
    }
    if (runLen >= 2) {
      if (candidate - last - 1 < minGapAfterDouble) return false; // 공백 부족
    }

    return true;
  };

  // 이상적 위치: n / (target+1) 간격
  const gap = n / (target + 1);
  for (let k = 1; k <= target; k++) {
    const ideal = Math.round(k * gap) - 1; // 0-index 보정
    // ideal에 가장 가까운 이모지 후보 찾기(좌우로 탐색)
    let pick = null,
      bestDist = Infinity;
    for (const idx of idxWithEmoji) {
      if (used.has(idx)) continue;
      const dist = Math.abs(idx - ideal);
      if (dist < bestDist && okWithRuns(idx)) {
        bestDist = dist;
        pick = idx;
      }
    }
    // 제약 때문에 못 고르면, 아무거나 제약 통과하는 첫 후보
    if (pick == null) {
      for (const idx of idxWithEmoji) {
        if (!used.has(idx) && okWithRuns(idx)) {
          pick = idx;
          break;
        }
      }
    }
    if (pick != null) {
      keep.add(pick);
      used.add(pick);
    }
  }

  // 혹시 타겟 못 채웠으면 남은 후보로 채우되 제약 유지
  for (const idx of idxWithEmoji) {
    if (keep.size >= target) break;
    if (!used.has(idx) && okWithRuns(idx)) {
      keep.add(idx);
      used.add(idx);
    }
  }

  // 3) 보존하지 않은 라인의 이모지는 제거
  return lines.map((t, i) => (keep.has(i) ? t : stripEmojis(t)));
}

// ----------------------------------------------------
// 프롬프트 생성 함수
// ----------------------------------------------------
function buildPrompt(summary, n, opts = {}) {
  const { emoji = true } = opts;

  return `
너는 네이버 영수증 리뷰를 작성하는 실제 고객 역할이야.
내가 주는 업체 소개 자료(PDF 요약)를 기반으로 리뷰를 작성해.
업체의 업종, 메뉴, 특징, 서비스 내용에 맞지 않는 말은 절대 쓰지 마.
(예: 단체룸 없는 곳에 단체룸 리뷰, 음식점이 아닌데 '맛있다' 같은 표현 금지)
업체명을 직접 언급하지 말고, 대신 '이곳', '여기', '방문한 곳' 등 자연스러운 대명사로만 표현해.
말투는 일상적인 존댓말로, 과장/광고문구(최고의, 강력추천 등)와 반복적인 형용사는 피하고 담백하게 작성.

리뷰 규칙:
1) 반드시 1~2문장으로 짧고 자연스럽게 작성
2) 존댓말 중심, 가끔 캐주얼(ㅎ, ㅎㅎ, ㅋㅋ 등) 허용
3) 문장은 반드시 하나의 종결로 끝낼 것
   - 허용 종결: ~습니다 / ~어요 / ~다 / ~음 / ㅎ / ㅎㅎ / ㅎㅎㅎ / ㅋㅋ / ㅋㅋㅋ / ! / !! / !!!
   - 이모지를 쓰면 반드시 문장 끝에서 단독으로만 사용
   - 마침표(.) 뒤에는 다른 끝맺음이나 이모지 붙이지 말 것
   - 예외 허용: "~습니다 ㅎ/ㅎㅎ/ㅎㅎㅎ"
   - 금지 예시: "좋았습니다 다", "좋았어요 요", "했습니다음", "요요", "다요", "음음", "음요", "음다"
4) 이모지: ${
    emoji ? "리뷰마다 0~2개만 자연스럽게 사용" : "사용하지 않음"
  }, 반드시 문장 끝에서 단독 사용
5) 같은 문장/표현 반복 금지
6) 첫 문장 시작 시 ".", ")" 같은 특수기호 금지
7) 표현의 다양화: 같은 말 반복 금지

[업체 요약]
${summary}

[요청] 리뷰 ${n}개를 한 줄에 하나씩 출력해.
`.trim();
}

// ----------------------------------------------------
// PDF → 텍스트 간단 추출
// ----------------------------------------------------
async function extractPdfText(buffer, maxChars = 3000) {
  const data = await pdfParse(buffer);
  const joined = (data.text || "").trim();
  return joined.slice(0, maxChars);
}

// ----------------------------------------------------
// OpenAI 호출: 요약을 입력으로 리뷰 n개 생성
// ----------------------------------------------------
async function generateFromSummary(summary, n, options = {}) {
  const { temperature = 0.7, model = "gpt-4o-mini", emoji = true } = options;
  const prompt = buildPrompt(summary, n, { emoji });

  const resp = await openai.chat.completions.create({
    model, // 계정에서 사용 가능한 모델명으로 교체 가능
    temperature, // 창의성 정도 (0.2~0.9 권장)
    messages: [{ role: "user", content: prompt }],
  });

  // 여기서 raw를 선언해야 함
  const raw = resp.choices?.[0]?.message?.content || "";

  // 줄 분리 + 전처리/후처리 파이프라인
  const lines = raw
    .replace(/\r/g, "")
    .split("\n")
    .map(stripLeadMarker)
    .map(normalizeEnding)
    .map((s) =>
      appendContextEmojisAtEnd(s, { enable: emoji, fallbackProb: 0.35 })
    )
    .map(cleanEmojiPlacement)
    .map((s) => s.trim())
    .filter(Boolean);

  // 👉 emoji 옵션이 false면 이모지 싹 제거하고 반환
  if (!emoji) {
    return lines.slice(0, n).map(stripEmojis);
  }

  // ✅ 여기서 이모지 총량/분산/연속제한 적용
  const limited = enforceEmojiQuotaAndSpread(lines.slice(0, n), {
    minPct: options.minPct ?? 0.1,
    maxPct: options.maxPct ?? 0.15,
    maxRun: 2,
    minGapAfterDouble: 2,
  });

  return limited;
}

// ----------------------------------------------------
// 라우트
// ----------------------------------------------------
const upload = multer({ storage: multer.memoryStorage() });

// 1) 처음: PDF 업로드 + N → 요약 추출 후 리뷰 생성
//    body: { n, temperature?, model?, emoji? }, file: pdf
app.post("/api/generate-from-file", upload.single("file"), async (req, res) => {
  try {
    const n = Math.min(parseInt(req.body.n || "10", 10), 200);
    if (!req.file) return res.status(400).json({ error: "파일이 없습니다." });

    const options = {
      temperature: req.body.temperature ? Number(req.body.temperature) : 0.7,
      model: req.body.model || "gpt-4o-mini",
      emoji: req.body.emoji === "false" ? false : true,
      minPct: req.body.minPct ? Number(req.body.minPct) : 0.1,
      maxPct: req.body.maxPct ? Number(req.body.maxPct) : 0.15,
    };

    const summary = await extractPdfText(req.file.buffer);
    const reviews = await generateFromSummary(summary, n, options);
    res.json({ summary, reviews, options });
  } catch (err) {
    console.error("[/api/generate-from-file] error:", err);
    res.status(500).json({ error: "생성 실패" });
  }
});

// 2) 이후: 요약(summary)만 보내서 N개 재생성 (선택 행 교체용)
//    body: { summary, n, temperature?, model?, emoji? }
app.post("/api/generate", async (req, res) => {
  try {
    const { summary, n = 1, temperature, model, emoji } = req.body || {};
    if (summary == null)
      return res.status(400).json({ error: "summary가 없습니다." });

    const options = {
      temperature: typeof temperature === "number" ? temperature : 0.7,
      model: model || "gpt-4o-mini",
      emoji: emoji === false ? false : true,
      minPct: req.body.minPct ? Number(req.body.minPct) : 0.1,
      maxPct: req.body.maxPct ? Number(req.body.maxPct) : 0.15,
    };

    const reviews = await generateFromSummary(summary, Number(n), options);
    res.json({ reviews, options });
  } catch (err) {
    console.error("[/api/generate] error:", err);
    res.status(500).json({ error: "생성 실패" });
  }
});

// 헬스체크
app.get("/api/health", (_, res) => res.json({ ok: true }));

// ----------------------------------------------------
// 서버 시작
// ----------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running: http://localhost:${PORT}`);
});
