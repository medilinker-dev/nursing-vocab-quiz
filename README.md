# 간호 단어 퀴즈

간호학과 교육자료(소화계통/신경계통)의 영어 단어를 40문항 사이클로 학습하는 정적 웹앱입니다. 백엔드 없음, 학습 기록은 사용자 브라우저의 localStorage에만 저장됩니다.

## 로컬 실행

빌드 도구·번들러 없이 정적 파일만으로 동작합니다.

```bash
npm run dev          # → http://localhost:5173
# 또는
python3 -m http.server 5173
```

`npm run dev`는 내부적으로 `npx serve`를 띄우는 한 줄짜리 스크립트입니다 (의존성 없음, 첫 실행 시 `serve`만 캐시).

## Vercel 배포

1. GitHub 리포에 push.
2. Vercel에서 New Project → 해당 리포 선택.
3. Framework Preset: **Other**, Build Command 비움, Output Directory `.`.
4. Deploy.

`vercel.json`이 정적 캐시 정책(`/data/*`는 5분, `index.html`은 no-cache)을 설정해 줍니다.

## 단어 데이터 갱신

원본 PDF 두 개(`04 소화계통.pdf`, `08 신경계통.pdf`)에서 단어를 추출해 `data/subject1.json`, `data/subject2.json`을 만듭니다.

### 의존성

```bash
python3 -m pip install --user pdfplumber
```

### 추출 실행

```bash
python3 scripts/extract.py
```

출력:
- `data/subject1.json` — 소화계통 단어
- `data/subject2.json` — 신경계통 단어
- (필요 시) `data/subject*_review.json` — 검수 보류 항목

### 푸시 → 자동 재배포

```bash
git add data/
git commit -m "data: update vocab"
git push
```

기존 사용자가 새로고침하면 새 단어 풀이 적용됩니다. 학습 기록은 localStorage에 그대로 남아 있습니다.

## 데이터 스키마

```json
{
  "subjectId": "subject1",
  "subjectName": "소화계통",
  "version": "2026-05-10",
  "words": [
    {
      "id": "s1-0001",
      "en": "oral cavity",
      "ko": "입안",
      "alt_en": ["GB"],
      "alt_ko": ["구강"],
      "note": ""
    }
  ]
}
```

- `en`: 정답 영어 (소문자 비교, 대소문자·마침표·여분 공백은 자동 정규화)
- `alt_en`: 동의어/약어. 주관식 채점에서 정답으로 인정.
- `ko`: 1차 한글 뜻 (객관식 정답 매칭)
- `alt_ko`: 한글 동의어. 주관식의 한글 보조 표시에 사용.

## 학습 기록 (localStorage)

- 키 네임스페이스: `nursingQuiz.v1.*`
- `nursingQuiz.v1.attempts`: 최근 시도 100건 (FIFO)
- `nursingQuiz.v1.wordStats`: 단어별 누적 노출/오답 카운트
- 학습 기록 화면에서 "초기화" 버튼으로 삭제 가능. 다른 localStorage 키는 건드리지 않습니다.
