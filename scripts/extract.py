"""PDF → subject JSON extractor for 간호학과 단어 퀴즈.

Usage:
    python3 scripts/extract.py

Reads "04 소화계통.pdf" and "08 신경계통.pdf" from the project root and
writes data/subject1.json and data/subject2.json.

Heuristics:
- Bullets begin with "•" (sometimes "·").
- A bullet is "<english part> <korean part>" possibly with synonyms separated
  by commas, possibly followed by another english/korean pair (a second word
  packed onto the same bullet line).
- Multi-line bullets are merged until the next bullet starts.
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
]

HANGUL_RE = re.compile(r"[가-힣ㄱ-ㆎ]")
LATIN_RE = re.compile(r"[A-Za-z]")
BULLET_CHARS = "•·"


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
        summary.append((src["subjectName"], len(words), len(review), out_path))

    for name, nwords, nreview, path in summary:
        print(f"{name}: {nwords} words → {path.name} (review: {nreview})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
