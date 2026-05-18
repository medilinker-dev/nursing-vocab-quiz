"""PDF → subject JSON extractor for 간호학과 단어 퀴즈.

Usage:
    python3 scripts/extract.py

Reads the source PDFs from the project root and writes data/subject{1,2,3}.json.

Heuristics:
- Bullets begin with "•" (sometimes "·").
- A bullet is "<english part> <korean part>" possibly with synonyms separated
  by commas, possibly followed by another english/korean pair (a second word
  packed onto the same bullet line).
- Multi-line bullets are merged until the next bullet starts.
- Abbreviation ("약어") sections are image-only in some PDFs; those entries are
  transcribed into EXTRA_ABBREVIATIONS and merged after bullet extraction.
"""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
SOURCES = [
    {
        "pdf": ROOT / "04 소화계통.pdf",
        "out": ROOT / "data" / "subject1.json",
        "subjectId": "subject1",
        "subjectName": "소화계통",
        "prefix": "s1",
    },
    {
        "pdf": ROOT / "08 신경계통.pdf",
        "out": ROOT / "data" / "subject2.json",
        "subjectId": "subject2",
        "subjectName": "신경계통",
        "prefix": "s2",
    },
    {
        "pdf": ROOT / "09 근골격계통.pdf",
        "out": ROOT / "data" / "subject3.json",
        "subjectId": "subject3",
        "subjectName": "근골격계통",
        "prefix": "s3",
    },
]

HANGUL_RE = re.compile(r"[가-힣ㄱ-ㆎ]")
LATIN_RE = re.compile(r"[A-Za-z]")
BULLET_CHARS = "•·"

# Abbreviation ("약어") sections of some PDFs are embedded as images, so plain
# text extraction misses them. They are transcribed here by subject and merged
# into the output after the bullet extraction. Each entry:
#   (abbreviation, [full English form(s)], Korean, [Korean alternatives])
EXTRA_ABBREVIATIONS = {
    # 04 소화계통.pdf — pages 43~44 ("8. 약어")
    "subject1": [
        ("AFP", ["alpha-fetoprotein"], "알파태아단백질", []),
        ("ALP", ["alkaline phosphatase"], "알칼리성 인산분해효소", []),
        ("ALT", ["alanine aminotransferase", "SGPT"], "알라닌 아미노전달효소", []),
        ("AST", ["aspartate aminotransferase", "SGOT"], "아스파르테이트 아미노전달효소", []),
        ("A/N/V/D/C", ["anorexia/nausea/vomit/diarrhea/constipation"],
         "식욕부진/오심/구토/설사/변비", []),
        ("BaE", ["barium enema"], "바륨관장", []),
        ("CBD", ["common bile duct"], "총담관", []),
        ("CT scan", ["computed tomography"], "컴퓨터단층촬영", []),
        ("EGD", ["esophagogastroduodenoscopy"], "식도위십이지장내시경술", []),
        ("ERCP", ["endoscopic retrograde cholangiopancreatography"],
         "내시경역행췌담관조영", []),
        ("FAP", ["familial adenomatous polyposis"], "가족성 선종성용종증", []),
        ("GB", ["gallbladder"], "담낭", ["쓸개"]),
        ("GERD", ["gastroesophageal reflux disease"], "위식도역류병", []),
        ("GI", ["gastrointestinal"], "위장관의", []),
        ("HAV", ["hepatitis A virus"], "A형 간염바이러스", []),
        ("HBV", ["hepatitis B virus"], "B형 간염바이러스", []),
        ("HCV", ["hepatitis C virus"], "C형 간염바이러스", []),
        ("IBD", ["inflammatory bowel disease"], "염증장질환", []),
        ("IBS", ["irritable bowel syndrome"], "과민대장증후군", []),
        ("IVC", ["intravenous cholangiography"], "정맥내담관조영", []),
        ("LFT", ["liver function test"], "간기능검사", []),
        ("LLQ", ["left lower quadrant"], "좌하복부", []),
        ("LUQ", ["left upper quadrant"], "좌상복부", []),
        ("NG tube", ["nasogastric tube"], "코위관", []),
        ("NPO", ["nothing per os"], "금식", []),
        ("PCNA", ["percutaneous needle aspiration biopsy"], "피부경유침흡인생검", []),
        ("PEG", ["percutaneous endoscopic gastrostomy"], "피부경유내시경위창냄술", []),
        ("PEI", ["percutaneous ethanol injection"], "피부경유에탄올주사", []),
        ("PPDS", ["pylorus-preserving pancreaticoduodenectomy"],
         "날문보존췌십이지장절제", []),
        ("PTBD", ["percutaneous transhepatic biliary drainage"],
         "피부간경유담즙배액", []),
        ("PTC", ["percutaneous transhepatic cholangiography"],
         "피부간경유담관조영", []),
        ("RFA", ["radiofrequency ablation"], "고주파열치료", []),
        ("RLQ", ["right lower quadrant"], "우하복부", []),
        ("RUQ", ["right upper quadrant"], "우상복부", []),
        ("TACE", ["transcatheter arterial chemoembolization",
                  "transarterial chemoembolization"],
         "도관경유화학색전술", ["동맥경유화학색전술"]),
        ("TACI", ["transarterial chemoinfusion"], "도관경유항암주입요법", []),
        ("TPN", ["total parenteral nutrition"], "완전비경구영양", []),
        ("UGIS", ["upper gastrointestinal series"], "상부위장관조영", []),
    ],
    # 08 신경계통.pdf — pages 33~34 ("8. 약어")
    "subject2": [
        ("AD", ["Alzheimer disease", "dementia"], "알츠하이머병", ["치매"]),
        ("AIDP", ["acute inflammatory demyelinating polyneuropathy"],
         "급성염증탈수초다발성신경병증", []),
        ("ALS", ["amyotrophic lateral sclerosis", "acute lateral sclerosis"],
         "근위축측삭경화증", ["급성측삭경화증"]),
        ("ANS", ["autonomic nervous system"], "자율신경계", []),
        ("CNS", ["central nervous system"], "중추신경계", []),
        ("CP", ["cerebral palsy"], "뇌성마비", []),
        ("CSF", ["cerebrospinal fluid"], "뇌척수액", []),
        ("CVA", ["cerebrovascular accident"], "뇌졸중", []),
        ("CVD", ["cerebrovascular disease"], "뇌혈관질환", []),
        ("DBS", ["deep brain stimulation"], "깊은뇌자극", ["심부뇌자극"]),
        ("DTR", ["deep tendon reflex"], "심부건반사", []),
        ("EDH", ["epidural hematoma"], "경막외혈종", ["경막바깥혈종"]),
        ("EEG", ["electroencephalography"], "뇌파검사", []),
        ("EST", ["electroconvulsive therapy"], "전기경련요법", []),
        ("GCS", ["Glasgow Coma Scale"], "글래스고혼수척도", []),
        ("HIVD", ["herniated intervertebral disk"], "탈출추간판", []),
        ("HNP", ["herniated nucleus pulposus"], "탈출수핵원반", []),
        ("ICP", ["intracranial pressure"], "두개내압", []),
        ("KJ", ["knee jerk"], "무릎반사", []),
        ("LP", ["lumbar puncture"], "요추천자", []),
        ("MRI", ["magnetic resonance imaging"], "자기공명영상", []),
        ("MS", ["multiple sclerosis"], "다발성경화증", []),
        ("NCV", ["nerve conduction velocity"], "신경전도속도", []),
        ("NICU", ["neurosurgical intensive care unit"], "신경외과집중치료실", []),
        ("NRS", ["numeric rating scale"], "수치통증척도", []),
        ("OBS", ["organic brain syndrome"], "기질성뇌증후군", []),
        ("PNS", ["peripheral nervous system"], "말초신경계", []),
        ("PEG", ["pneumoencephalography"], "공기뇌조영", []),
        ("SDH", ["subarachnoid hemorrhage"], "거미막밑출혈", ["지주막하출혈"]),
        ("TIA", ["transient ischemic attack"], "일과성허혈발작", []),
        ("VAS", ["visual analogue scale"], "시각통증등급", []),
        ("VP shunt", ["ventriculoperitoneal shunt"], "뇌실복막강션트", []),
    ],
    # 09 근골격계통.pdf — pages 44~45 ("7. 약어")
    "subject3": [
        ("AchR", ["acetylcholine receptor"], "아세틸콜린 수용체", []),
        ("AKA", ["above knee amputation"], "무릎위 절단", []),
        ("ALS", ["amyotrophic lateral sclerosis"], "근위축측삭경화증", []),
        ("AVN", ["avascular necrosis"], "무혈성괴사", []),
        ("BMD", ["bone mineral densitometry"], "골무기질밀도측정", []),
        ("BG", ["bone graft"], "골이식", []),
        ("BKA", ["below knee amputation"], "무릎아래 절단", []),
        ("BM", ["bone marrow"], "골수", []),
        ("C1, C2", ["cervical vertebrae"], "제1·제2 목뼈", ["경추"]),
        ("C/R c̄ EF", ["closed reduction with external fixation"],
         "외부고정을 동반한 비관혈적정복", []),
        ("C/R c̄ IF", ["closed reduction with internal fixation"],
         "내부고정을 동반한 비관혈적정복", []),
        ("CTS", ["carpal tunnel syndrome"], "손목굴증후군", []),
        ("DJD", ["degenerative joint disease"], "퇴행관절질환", []),
        ("DTR", ["deep tendon reflex"], "심부건반사", []),
        ("EMG", ["electromyography"], "근전도", []),
        ("ESR", ["erythrocyte sedimentation rate"], "적혈구침강률", []),
        ("Fx.", ["fracture"], "골절", []),
        ("HIVD", ["herniated intervertebral disc"], "탈출추간판", []),
        ("HLD", ["herniated lumbar disk"], "탈출요추간판", []),
        ("HNP", ["herniated nucleus pulposus"], "탈출수핵", []),
        ("ICS", ["intercostal space"], "갈비사이공간", []),
        ("KJ", ["knee jerk"], "무릎반사", []),
        ("L1, L2", ["lumbar vertebra"], "제1·제2 허리뼈", ["요추"]),
        ("LBP", ["low back pain"], "허리통증", []),
        ("NSAIDs", ["nonsteroidal antiinflammatory drugs"], "비스테로이드소염제", []),
        ("NCV", ["nerve conduction velocity"], "신경전도속도", []),
        ("O/R c̄ IF", ["open reduction with internal fixation"],
         "내부고정을 동반한 관혈적정복", []),
        ("OS", ["orthopedic surgery", "orthopedics"], "정형외과", []),
        ("RA", ["rheumatoid arthritis"], "류마티스관절염", []),
        ("RF", ["rheumatoid factor"], "류마티스인자", []),
        ("ROM", ["range of motion"], "운동범위", []),
        ("SLR", ["straight leg raising test"], "펴다리올림검사", []),
        ("T1, T2", ["thoracic vertebra"], "제1·제2 등뼈", ["흉추"]),
        ("THRA", ["total hip replacement arthroplasty"], "전체엉덩관절치환", []),
        ("TKRA", ["total knee replacement arthroplasty"], "전체무릎관절치환", []),
        ("WBBS", ["whole body bone scan"], "전신골스캔", []),
    ],
}


def is_hangul(ch: str) -> bool:
    return bool(HANGUL_RE.match(ch))


def is_latin(ch: str) -> bool:
    return bool(LATIN_RE.match(ch))


def collapse_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def strip_trailing_junk(s: str) -> str:
    return s.strip().strip(",;").strip()


@dataclass
class Word:
    id: str
    en: str
    ko: str
    alt_en: list[str] = field(default_factory=list)
    alt_ko: list[str] = field(default_factory=list)
    note: str = ""

    def to_dict(self) -> dict:
        d: dict = {"id": self.id, "en": self.en, "ko": self.ko}
        if self.alt_en:
            d["alt_en"] = self.alt_en
        if self.alt_ko:
            d["alt_ko"] = self.alt_ko
        if self.note:
            d["note"] = self.note
        return d


def gather_bullets(pdf_path: Path) -> list[str]:
    """Walk every line on every page; merge continuation lines until next bullet."""
    bullets: list[str] = []
    current: str | None = None
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            for raw in text.split("\n"):
                line = raw.strip()
                if not line:
                    continue
                if line and line[0] in BULLET_CHARS:
                    if current:
                        bullets.append(current)
                    current = line.lstrip(BULLET_CHARS).strip()
                else:
                    if current is not None:
                        if not _looks_like_continuation(current, line):
                            bullets.append(current)
                            current = None
                        else:
                            current = current + " " + line
    if current:
        bullets.append(current)
    return bullets


def _looks_like_continuation(prev: str, line: str) -> bool:
    """Decide whether `line` continues the previous bullet rather than being noise.

    Continuation lines we want: rest of an entry split mid-sentence (English or
    Korean). Noise we don't want: page footers, section headers like
    "3. 해부생리학적 용어 - …" or stray title fragments.
    """
    if not line:
        return False
    # Section headers / numbered headings.
    if re.match(r"^\d+\.\s", line):
        return False
    # Page-number-only lines.
    if re.match(r"^\d+\s*$", line):
        return False
    # Title-like Korean that has no English nor punctuation glue with prev.
    if "용어" in line and "-" in line and not LATIN_RE.search(line):
        return False
    # Heuristic: previous bullet ended with `,` or has unbalanced parens, or
    # the line starts with lowercase English / Korean punctuation continuation.
    if prev.rstrip().endswith(","):
        return True
    if line[0].islower():
        return True
    if line[0] in "()-" or is_hangul(line[0]):
        return True
    if prev.count("(") != prev.count(")"):
        return True
    # Capitalized English starting a continuation only after a comma — already
    # handled above. Otherwise treat as a new entity (not continuation).
    return False


def split_into_pairs(bullet: str) -> list[tuple[str, str]]:
    """Split a bullet text into a list of (english, korean) pairs.

    Strategy: walk left to right. Read English (Latin + punctuation + spaces +
    parens) until the first Hangul char. Then read Korean (Hangul + spaces +
    commas + parens, possibly containing English inside parens) until we hit
    Latin OUTSIDE parens, which signals a new pair.
    """
    s = collapse_ws(bullet)
    n = len(s)
    pairs: list[tuple[str, str]] = []
    i = 0

    while i < n:
        # Skip leading commas/spaces left over from previous segment.
        while i < n and s[i] in " ,":
            i += 1
        if i >= n:
            break

        # --- Read English block ---
        eng_start = i
        depth = 0
        while i < n:
            ch = s[i]
            if ch == "(":
                depth += 1
                i += 1
                continue
            if ch == ")":
                depth = max(0, depth - 1)
                i += 1
                continue
            # Inside parens: anything goes.
            if depth > 0:
                i += 1
                continue
            if is_hangul(ch):
                break
            i += 1
        eng = strip_trailing_junk(s[eng_start:i])

        if i >= n:
            # No Korean found; skip this fragment.
            break

        # --- Read Korean block ---
        kor_start = i
        depth = 0
        while i < n:
            ch = s[i]
            if ch == "(":
                depth += 1
                i += 1
                continue
            if ch == ")":
                depth = max(0, depth - 1)
                i += 1
                continue
            if depth > 0:
                i += 1
                continue
            # Outside parens: a Latin char *might* signal a new pair, but it
            # could also be embedded in a Korean phrase (e.g. "빌로트 I 수술",
            # "Glasgow Coma Scale" appearing as a quoted form). Peek ahead: if
            # the Latin run is followed by whitespace then Hangul, treat as
            # part of the Korean phrase; otherwise it starts a new pair.
            if is_latin(ch):
                j = i
                while j < n and (s[j].isalpha() or s[j].isdigit() or s[j] in ".-"):
                    j += 1
                latin_tok = s[i:j]
                k = j
                while k < n and s[k] == " ":
                    k += 1
                followed_by_hangul = k < n and is_hangul(s[k])
                # Only treat as embedded if the Latin token looks like a
                # Roman numeral / short uppercase abbreviation: short and
                # without any lowercase letter. Otherwise (e.g. a real word
                # like "gastroduodenostomy"), it starts a new pair.
                short_caps = (
                    len(latin_tok) <= 4
                    and latin_tok.isalpha()
                    and not any(c.islower() for c in latin_tok)
                )
                if followed_by_hangul and short_caps:
                    i = j
                    continue
                cut = s.rfind(",", kor_start, i)
                if cut == -1:
                    break
                i = cut
                break
            i += 1
        kor = strip_trailing_junk(s[kor_start:i])

        if eng and kor:
            pairs.append((eng, kor))

    return pairs


def split_synonyms(text: str) -> list[str]:
    """Split on top-level commas (not inside parens)."""
    out: list[str] = []
    depth = 0
    buf = []
    for ch in text:
        if ch == "(":
            depth += 1
            buf.append(ch)
        elif ch == ")":
            depth = max(0, depth - 1)
            buf.append(ch)
        elif ch == "," and depth == 0:
            piece = "".join(buf).strip()
            if piece:
                out.append(piece)
            buf = []
        else:
            buf.append(ch)
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out


def extract_paren_abbrev(en_term: str) -> tuple[str, list[str], str]:
    """Pull `(ABBR)` out of `something(ABBR)` or `something (ABBR)`.

    Returns (clean_term, abbrev_list, note_fragment).
    """
    abbrevs: list[str] = []
    notes: list[str] = []

    def _replace(match: re.Match) -> str:
        inside = match.group(1).strip()
        if not inside:
            return ""
        # Heuristic: short uppercase-ish token = abbrev; otherwise note.
        if (
            len(inside) <= 12
            and not is_hangul(inside[0])
            and re.match(r"^[A-Za-z0-9 .\-]+$", inside)
        ):
            abbrevs.append(inside)
        else:
            notes.append(inside)
        return ""

    cleaned = re.sub(r"\(([^()]*)\)", _replace, en_term)
    cleaned = collapse_ws(cleaned)
    return cleaned, abbrevs, " / ".join(notes)


def normalize_entry(eng_raw: str, kor_raw: str) -> tuple[str, list[str], str, list[str], str]:
    """Return (en, alt_en, ko, alt_ko, note) for a single pair."""
    eng_syns = split_synonyms(eng_raw)
    notes: list[str] = []
    en_clean: list[str] = []
    abbrev_pool: list[str] = []
    for syn in eng_syns:
        clean, abbrevs, note = extract_paren_abbrev(syn)
        if clean:
            en_clean.append(clean)
        abbrev_pool.extend(abbrevs)
        if note:
            notes.append(note)

    # Korean: keep parens visible (e.g. `(8쌍)`), but pull out English content.
    kor_syns = split_synonyms(kor_raw)
    ko_clean: list[str] = []
    for syn in kor_syns:
        # Strip a trailing standalone (English…) tail and treat it as alt_en.
        m = re.match(r"^(.*?)\s*\(([^()]*)\)\s*$", syn)
        kept = syn
        if m and m.group(2) and not is_hangul(m.group(2)[0]) and re.search(r"[A-Za-z]", m.group(2)):
            inside = m.group(2).strip()
            front = m.group(1).strip()
            if front and is_hangul(front[-1]):
                # English-in-parens after Korean → treat as English synonym.
                for piece in split_synonyms(inside):
                    if piece:
                        abbrev_pool.append(piece)
                kept = front
        if kept:
            ko_clean.append(kept)

    if not en_clean or not ko_clean:
        return "", [], "", [], ""

    en = en_clean[0]
    alt_en = []
    for s in en_clean[1:]:
        if s and s.lower() != en.lower() and s not in alt_en:
            alt_en.append(s)
    for s in abbrev_pool:
        if s and s.lower() != en.lower() and s not in alt_en:
            alt_en.append(s)

    ko = ko_clean[0]
    alt_ko = [s for s in ko_clean[1:] if s != ko]

    return en, alt_en, ko, alt_ko, " / ".join(n for n in notes if n)


NOISE_KO_HINTS = ("이다.", "있다.", "한다.", "된다.", "이며,", "이고,", "포함한다", "관여한다")


def looks_like_sentence(ko: str) -> bool:
    """Detect bullets that are full Korean sentences (not vocabulary)."""
    if any(hint in ko for hint in NOISE_KO_HINTS):
        return True
    # Long Korean phrase with verb endings.
    if len(ko) > 40 and ko.endswith("."):
        return True
    return False


def too_short(en: str, ko: str) -> bool:
    if len(en) < 2 or len(ko) < 1:
        return True
    if not LATIN_RE.search(en):
        return True
    return False


def too_long(en: str, ko: str) -> bool:
    return len(en) > 80 or len(ko) > 80


def build_words(bullets: list[str], prefix: str) -> tuple[list[Word], list[dict]]:
    seen_keys: set[str] = set()
    words: list[Word] = []
    review: list[dict] = []
    counter = 1

    for bullet in bullets:
        pairs = split_into_pairs(bullet)
        if not pairs:
            continue
        for eng_raw, kor_raw in pairs:
            en, alt_en, ko, alt_ko, note = normalize_entry(eng_raw, kor_raw)
            if not en or not ko:
                continue
            if too_short(en, ko) or too_long(en, ko):
                review.append({"reason": "length", "en": en, "ko": ko, "raw": bullet})
                continue
            if looks_like_sentence(ko):
                review.append({"reason": "sentence", "en": en, "ko": ko, "raw": bullet})
                continue
            key = (en.lower(), ko)
            if key in seen_keys:
                continue
            seen_keys.add(key)
            words.append(
                Word(
                    id=f"{prefix}-{counter:04d}",
                    en=en,
                    ko=ko,
                    alt_en=alt_en,
                    alt_ko=alt_ko,
                    note=note,
                )
            )
            counter += 1
    return words, review


def main() -> int:
    today = date.today().isoformat()
    summary = []
    for src in SOURCES:
        pdf_path: Path = src["pdf"]
        if not pdf_path.exists():
            print(f"[skip] missing: {pdf_path}", file=sys.stderr)
            continue
        bullets = gather_bullets(pdf_path)
        words, review = build_words(bullets, src["prefix"])

        # Merge transcribed abbreviation entries (image-only PDF pages).
        extras = EXTRA_ABBREVIATIONS.get(src["subjectId"], [])
        n_extra = 0
        for k, (abbr, full_ens, ko, alt_kos) in enumerate(extras):
            words.append(
                Word(
                    id=f"{src['prefix']}-{len(words) + 1:04d}",
                    en=abbr,
                    ko=ko,
                    alt_en=list(full_ens),
                    alt_ko=list(alt_kos),
                    note="약어",
                )
            )
            n_extra += 1

        out_path: Path = src["out"]
        out_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "subjectId": src["subjectId"],
            "subjectName": src["subjectName"],
            "version": today,
            "words": [w.to_dict() for w in words],
        }
        out_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        if review:
            review_path = out_path.with_name(out_path.stem + "_review.json")
            review_path.write_text(
                json.dumps(review, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        summary.append((src["subjectName"], len(words), n_extra, len(review), out_path))

    for name, nwords, nextra, nreview, path in summary:
        extra_note = f", 약어 {nextra}개 포함" if nextra else ""
        print(f"{name}: {nwords} words → {path.name} (review: {nreview}{extra_note})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
