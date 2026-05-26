/* 간호 단어 퀴즈 — 단일 페이지 SPA */
(function () {
  "use strict";

  // ---------- Constants ----------
  const SUBJECT_FILES = [
    "data/subject1.json",
    "data/subject2.json",
    "data/subject3.json",
    "data/subject4.json",
  ];
  const COUNT_OPTIONS = [5, 10, 15, 20, 25, 30, 35, 40];
  const DEFAULT_COUNT = 40;
  const MAX_TYPEA_ATTEMPTS = 3; // 1=오답, 2=힌트, 3=정답 공개
  const ATTEMPT_HISTORY_LIMIT = 100;
  const STORAGE_KEYS = {
    attempts: "nursingQuiz.v1.attempts",
    wordStats: "nursingQuiz.v1.wordStats",
    count: "nursingQuiz.v1.count",
    bookmarks: "nursingQuiz.v1.bookmarks",
    flashcardPrefs: "nursingQuiz.v1.flashcardPrefs",
    homeMode: "nursingQuiz.v1.homeMode",
  };
  // Auto-advance disabled: user always clicks "다음 →" to proceed.

  // ---------- State ----------
  const state = {
    subjects: {}, // subjectId -> { subjectId, subjectName, version, words[] }
    currentRoute: "home",
    quiz: null,         // active quiz session
    flashcard: null,    // active flashcard session
    selectedCount: DEFAULT_COUNT,
    homeMode: "quiz",   // "quiz" | "flashcard"
  };

  // ---------- DOM helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v !== false && v !== null && v !== undefined) {
        node.setAttribute(k, v);
      }
    }
    for (const child of [].concat(children)) {
      if (child == null || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ---------- Storage ----------
  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      console.warn("storage read failed", key, e);
      return fallback;
    }
  }
  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn("storage write failed", key, e);
    }
  }
  function getAttempts() { return readJSON(STORAGE_KEYS.attempts, []); }
  function getWordStats() { return readJSON(STORAGE_KEYS.wordStats, {}); }
  function getStoredCount() {
    const v = readJSON(STORAGE_KEYS.count, null);
    return COUNT_OPTIONS.includes(v) ? v : DEFAULT_COUNT;
  }
  function setStoredCount(v) { writeJSON(STORAGE_KEYS.count, v); }
  function clearLearningData() {
    // 학습 기록만 지우고 사용자가 고른 문항 수·북마크는 보존.
    localStorage.removeItem(STORAGE_KEYS.attempts);
    localStorage.removeItem(STORAGE_KEYS.wordStats);
  }
  function getBookmarks() { return readJSON(STORAGE_KEYS.bookmarks, {}); }
  function isBookmarked(id) { return Boolean(getBookmarks()[id]); }
  function toggleBookmark(id) {
    const bm = getBookmarks();
    if (bm[id]) delete bm[id];
    else bm[id] = Date.now();
    writeJSON(STORAGE_KEYS.bookmarks, bm);
    return Boolean(bm[id]);
  }
  function getFlashcardPrefs() {
    return readJSON(STORAGE_KEYS.flashcardPrefs, {
      shuffle: false,
      autoplay: false,
      hideMeaning: false,
      filter: "all",
    });
  }
  function setFlashcardPrefs(p) { writeJSON(STORAGE_KEYS.flashcardPrefs, p); }
  function getHomeMode() {
    const v = readJSON(STORAGE_KEYS.homeMode, "quiz");
    return v === "flashcard" ? "flashcard" : "quiz";
  }
  function setHomeMode(v) { writeJSON(STORAGE_KEYS.homeMode, v); }

  function recordAttempt(attempt) {
    const list = getAttempts();
    list.unshift(attempt);
    if (list.length > ATTEMPT_HISTORY_LIMIT) list.length = ATTEMPT_HISTORY_LIMIT;
    writeJSON(STORAGE_KEYS.attempts, list);
  }
  function recordWordStats(perWord) {
    const stats = getWordStats();
    const now = Date.now();
    for (const [id, info] of Object.entries(perWord)) {
      const cur = stats[id] || { seen: 0, wrong: 0, lastWrongTs: 0 };
      cur.seen += info.seen || 0;
      cur.wrong += info.wrong || 0;
      if (info.wrong > 0) cur.lastWrongTs = now;
      stats[id] = cur;
    }
    writeJSON(STORAGE_KEYS.wordStats, stats);
  }

  // ---------- Subject summary ----------
  function getSubjectSummary(subjectId) {
    const attempts = getAttempts().filter((a) => a.subjectId === subjectId);
    if (attempts.length === 0) return null;
    const last = attempts[0];
    const sumPct = attempts.reduce((acc, a) => acc + (a.correct / a.total) * 100, 0);
    return {
      attempts: attempts.length,
      lastScore: `${last.correct} / ${last.total}`,
      avgPct: sumPct / attempts.length,
    };
  }

  // ---------- Data loading ----------
  async function loadSubjects() {
    const results = await Promise.allSettled(
      SUBJECT_FILES.map((p) => fetch(p, { cache: "no-cache" }))
    );
    const loaded = [];
    const errors = [];
    for (let i = 0; i < results.length; i++) {
      const path = SUBJECT_FILES[i];
      const res = results[i];
      if (res.status === "rejected") {
        errors.push({ path, message: res.reason && res.reason.message });
        continue;
      }
      const r = res.value;
      if (!r.ok) {
        errors.push({ path, message: `HTTP ${r.status}` });
        continue;
      }
      try {
        const data = await r.json();
        loaded.push(data);
      } catch (e) {
        errors.push({ path, message: "JSON parse error: " + e.message });
      }
    }
    return { loaded, errors };
  }

  // ---------- Routing ----------
  function setRoute(route) {
    state.currentRoute = route;
    const screens = {
      home: $("#screen-home"),
      quiz: $("#screen-quiz"),
      result: $("#screen-result"),
      history: $("#screen-history"),
      flashcard: $("#screen-flashcard"),
    };
    for (const [name, node] of Object.entries(screens)) {
      if (!node) continue;
      if (name === route) node.removeAttribute("hidden");
      else node.setAttribute("hidden", "");
    }
    $$(".navlink").forEach((b) => {
      b.classList.toggle("active", b.dataset.route === route);
    });
    window.scrollTo({ top: 0 });
  }

  // ---------- Home ----------
  function renderCountPicker() {
    const wrap = $("#countPicker");
    if (!wrap) return;
    // Keep the static label, drop any previously rendered chips.
    Array.from(wrap.querySelectorAll(".count-chip")).forEach((n) => n.remove());
    for (const c of COUNT_OPTIONS) {
      const chip = el(
        "button",
        {
          class: "count-chip" + (c === state.selectedCount ? " active" : ""),
          type: "button",
          role: "radio",
          "aria-checked": c === state.selectedCount ? "true" : "false",
          "data-count": String(c),
          onclick: () => {
            state.selectedCount = c;
            setStoredCount(c);
            renderCountPicker();
          },
        },
        String(c)
      );
      wrap.appendChild(chip);
    }
  }

  function renderModeTabs() {
    const tabs = $$(".mode-tab");
    tabs.forEach((t) => {
      const isActive = t.dataset.mode === state.homeMode;
      t.classList.toggle("active", isActive);
      t.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    // Hide count picker in flashcard mode.
    const picker = $("#countPicker");
    if (picker) picker.style.display = state.homeMode === "flashcard" ? "none" : "";
  }

  function renderHome() {
    renderModeTabs();
    renderCountPicker();
    const grid = $("#subjectGrid");
    clear(grid);
    const subjectIds = Object.keys(state.subjects);
    if (subjectIds.length === 0) {
      grid.appendChild(el("div", { class: "loading", text: "표시할 과목이 없습니다." }));
      return;
    }
    for (const sid of subjectIds) {
      const s = state.subjects[sid];
      grid.appendChild(buildSubjectCard(sid, s));
    }
  }

  function buildSubjectCard(sid, s) {
    if (state.homeMode === "flashcard") {
      const bookmarks = getBookmarks();
      const bookmarkedHere = s.words.filter((w) => bookmarks[w.id]).length;
      const stats = getWordStats();
      const wrongHere = s.words.filter((w) => stats[w.id] && stats[w.id].wrong > 0).length;
      const meta = el("div", { class: "meta" }, [
        el("div", {}, [el("strong", { text: `${s.words.length}` }), " 단어"]),
        el("div", {}, [el("strong", { text: `${bookmarkedHere}` }), " ⭐ 북마크"]),
        el("div", {}, [el("strong", { text: `${wrongHere}` }), " ❌ 자주 틀림"]),
      ]);
      return el("div", { class: "subject-card" }, [
        el("div", { class: "name", text: s.subjectName }),
        meta,
        el(
          "button",
          {
            class: "btn btn-primary start",
            type: "button",
            "aria-label": `${s.subjectName} 단어장 열기`,
            onclick: () => openFlashcards(sid),
          },
          "단어장 열기"
        ),
      ]);
    }
    // Quiz mode
    const summary = getSubjectSummary(sid);
    const meta = el("div", { class: "meta" }, [
      el("div", {}, [el("strong", { text: `${s.words.length}` }), " 단어"]),
      el(
        "div",
        {},
        summary
          ? [el("strong", { text: summary.lastScore }), " 최근 점수"]
          : [el("strong", { text: "—" }), " 최근 점수"]
      ),
      el(
        "div",
        {},
        summary
          ? [el("strong", { text: `${summary.avgPct.toFixed(1)}%` }), " 평균 정답률"]
          : [el("strong", { text: "—" }), " 평균 정답률"]
      ),
    ]);
    return el("div", { class: "subject-card" }, [
      el("div", { class: "name", text: s.subjectName }),
      meta,
      el(
        "button",
        {
          class: "btn btn-primary start",
          type: "button",
          "aria-label": `${s.subjectName} 퀴즈 시작`,
          onclick: () => startQuiz(sid),
        },
        "퀴즈 시작"
      ),
    ]);
  }

  function showLoadError(errors) {
    const grid = $("#subjectGrid");
    clear(grid);
    const lines = errors
      .map((e) => `${e.path}: ${e.message || "알 수 없음"}`)
      .join("\n");
    grid.appendChild(
      el("div", {
        class: "error-card",
        text: `단어 데이터를 불러오지 못했습니다.\n${lines}`,
      })
    );
  }

  // ---------- Quiz building ----------
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function pickN(arr, n) {
    return shuffle(arr).slice(0, n);
  }

  function balanceTypes(n) {
    // 50:50 within ±MAX_TYPE_DIFF.
    const half = Math.floor(n / 2);
    const types = [];
    for (let i = 0; i < n; i++) types.push(i < half ? "A" : "B");
    if (n % 2 === 1) types.push(Math.random() < 0.5 ? "A" : "B");
    return shuffle(types).slice(0, n);
  }

  function buildDistractors(correctWord, pool) {
    const candidates = pool.filter(
      (w) => w.id !== correctWord.id && w.ko !== correctWord.ko
    );
    const picked = [];
    const seen = new Set([correctWord.ko]);
    const shuffled = shuffle(candidates);
    for (const w of shuffled) {
      if (picked.length >= 3) break;
      if (seen.has(w.ko)) continue;
      seen.add(w.ko);
      picked.push(w.ko);
    }
    while (picked.length < 3) picked.push("(보기 부족)");
    return picked;
  }

  function startQuiz(subjectId, requestedCount) {
    const subject = state.subjects[subjectId];
    if (!subject) return;
    const pool = subject.words;
    const desired = requestedCount || state.selectedCount || DEFAULT_COUNT;
    const n = Math.min(desired, pool.length);
    const selected = pickN(pool, n);
    const types = balanceTypes(n);

    const questions = selected.map((w, i) => {
      const type = types[i];
      if (type === "A") {
        return { type: "A", word: w, attempts: 0 };
      }
      const distractors = buildDistractors(w, pool);
      const choices = shuffle([w.ko, ...distractors]);
      return { type: "B", word: w, choices };
    });

    state.quiz = {
      subjectId,
      subjectName: subject.subjectName,
      requestedCount: desired,
      questions,
      cursor: 0,
      correct: 0,
      results: [], // per-question { id, type, en, ko, correct, given, attempts }
    };

    setRoute("quiz");
    renderQuestion();
  }

  function quitQuiz() {
    if (!state.quiz) return setRoute("home");
    if (
      state.quiz.cursor > 0 &&
      !confirm("진행 중인 퀴즈를 그만두면 결과가 저장되지 않습니다. 계속할까요?")
    ) {
      return;
    }
    state.quiz = null;
    setRoute("home");
  }

  // ---------- Quiz rendering ----------
  function renderQuestion() {
    const q = state.quiz;
    if (!q) return;
    if (q.cursor >= q.questions.length) return finishQuiz();

    $("#qIndex").textContent = String(q.cursor + 1);
    $("#qTotal").textContent = String(q.questions.length);
    $("#qCorrect").textContent = String(q.correct);
    const pct = (q.cursor / q.questions.length) * 100;
    $("#progressFill").style.width = pct + "%";

    const box = $("#questionBox");
    clear(box);
    $("#feedbackBox").setAttribute("hidden", "");

    const item = q.questions[q.cursor];
    if (item.type === "A") renderTypeA(box, item);
    else renderTypeB(box, item);
  }

  function renderTypeA(box, item) {
    const w = item.word;
    box.appendChild(el("span", { class: "q-type-label", text: "주관식 · 한 → 영" }));
    box.appendChild(el("p", { class: "q-prompt", text: "다음 한글 뜻에 해당하는 영어 단어를 입력하세요." }));
    const target = el("h2", { class: "q-target", text: w.ko });
    if (w.alt_ko && w.alt_ko.length) {
      target.appendChild(
        el("span", {
          class: "q-prompt",
          style: "font-size:14px;font-weight:400;",
          text: ` (${w.alt_ko.join(", ")})`,
        })
      );
    }
    box.appendChild(target);

    const input = el("input", {
      class: "q-input",
      type: "text",
      autocomplete: "off",
      autocapitalize: "none",
      spellcheck: "false",
      "aria-label": "영어 단어 입력",
      placeholder: "english…",
    });
    const submit = el(
      "button",
      { class: "btn btn-primary", type: "button", onclick: () => submitTypeA(input.value) },
      "제출"
    );
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitTypeA(input.value);
      }
    });
    box.appendChild(el("div", { class: "q-input-row" }, [input, submit]));

    // Aux row: "정답 보기" link to skip remaining attempts.
    const aux = el("div", { class: "q-input-aux" }, [
      el(
        "button",
        {
          class: "link-btn",
          type: "button",
          id: "revealBtn",
          onclick: () => revealTypeA(),
        },
        "정답 보기 →"
      ),
    ]);
    box.appendChild(aux);

    // Attempt indicator (3 dots).
    const dots = el("div", { class: "q-attempts", "aria-label": "남은 시도" }, [
      el("span", { text: `시도 ${item.attempts}/${MAX_TYPEA_ATTEMPTS}` }),
    ]);
    for (let i = 0; i < MAX_TYPEA_ATTEMPTS; i++) {
      dots.appendChild(
        el("span", {
          class: "dot" + (i < item.attempts ? " used" : ""),
          "aria-hidden": "true",
        })
      );
    }
    box.appendChild(dots);

    setTimeout(() => input.focus(), 0);
  }

  function renderTypeB(box, item) {
    const w = item.word;
    box.appendChild(el("span", { class: "q-type-label type-b", text: "객관식 · 영 → 한" }));
    box.appendChild(el("p", { class: "q-prompt", text: "다음 영어 단어의 한글 뜻을 고르세요." }));

    const target = el("h2", { class: "q-target" }, [w.en]);
    target.appendChild(buildTtsButton(w.en));
    box.appendChild(target);

    const choicesWrap = el("div", { class: "q-choices", role: "list" });
    item.choices.forEach((choice, idx) => {
      const btn = el(
        "button",
        {
          class: "choice",
          type: "button",
          "data-choice": choice,
          "aria-label": `${idx + 1}번 보기: ${choice}`,
          onclick: () => submitTypeB(choice, btn),
        },
        [el("span", { class: "index", text: String(idx + 1) }), el("span", {}, choice)]
      );
      choicesWrap.appendChild(btn);
    });
    box.appendChild(choicesWrap);
  }

  // ---------- In-app browser detection / banner ----------
  function detectInAppBrowser() {
    const ua = (navigator.userAgent || "").toLowerCase();
    if (ua.includes("kakaotalk")) return { name: "kakao", label: "카카오톡" };
    if (ua.includes("naver(inapp")) return { name: "naver", label: "네이버 앱" };
    if (ua.includes("instagram")) return { name: "instagram", label: "인스타그램" };
    if (ua.includes("fban") || ua.includes("fbav") || ua.includes("fb_iab"))
      return { name: "facebook", label: "페이스북" };
    if (/\bline\//.test(ua)) return { name: "line", label: "라인" };
    return null;
  }

  function maybeShowInAppBanner() {
    const banner = $("#inAppBanner");
    if (!banner) return;
    if (sessionStorage.getItem("nursingQuiz.inAppDismissed") === "1") return;
    const info = detectInAppBrowser();
    if (!info) return;
    banner.removeAttribute("hidden");
    const msg = $("#inAppBannerMsg");
    if (msg) {
      msg.innerHTML = `${info.label} 내장 브라우저는 발음 재생이 막혀 있을 수 있어요. <b>크롬·사파리</b>로 열어주세요.`;
    }

    const url = window.location.href;
    const openBtn = $("#inAppOpenBtn");
    if (openBtn) {
      openBtn.addEventListener("click", () => openInExternalBrowser(url, info));
    }
    const copyBtn = $("#inAppCopyBtn");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(url);
          copyBtn.textContent = "복사됨 ✓";
          setTimeout(() => { copyBtn.textContent = "링크 복사"; }, 1800);
        } catch (e) {
          // Fallback: prompt so the user can copy manually.
          window.prompt("아래 주소를 길게 눌러 복사하세요", url);
        }
      });
    }
    const dismiss = $("#inAppDismissBtn");
    if (dismiss) {
      dismiss.addEventListener("click", () => {
        banner.setAttribute("hidden", "");
        sessionStorage.setItem("nursingQuiz.inAppDismissed", "1");
      });
    }
  }

  function openInExternalBrowser(url, info) {
    const isAndroid = /android/i.test(navigator.userAgent);
    if (isAndroid) {
      // Try Chrome via intent URL. If the device doesn't have Chrome, the
      // intent's S.browser_fallback_url will open the system browser.
      try {
        const stripped = url.replace(/^https?:\/\//, "");
        const intent =
          "intent://" +
          stripped +
          "#Intent;scheme=https;package=com.android.chrome;" +
          "S.browser_fallback_url=" + encodeURIComponent(url) + ";end";
        window.location.href = intent;
        return;
      } catch (e) {
        // fall through
      }
    }
    // iOS — there is no reliable way to escape the WebView; instruct the user.
    alert(
      "iOS 카톡에서는 자동으로 열 수 없어요.\n" +
      "오른쪽 상단 '⋯' (또는 공유) 버튼을 누르고\n" +
      "'Safari로 열기'를 선택하거나, 링크를 복사해서 Safari에 붙여넣어 주세요."
    );
  }

  // ---------- TTS ----------
  let ttsAvailable =
    typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined" &&
    typeof window.SpeechSynthesisUtterance !== "undefined";

  let cachedVoice = null;
  let voicesLoaded = false;

  function pickEnglishVoice() {
    if (!ttsAvailable) return null;
    if (typeof window.speechSynthesis.getVoices !== "function") return null;
    let voices = [];
    try { voices = window.speechSynthesis.getVoices() || []; } catch (e) { return null; }
    if (voices.length === 0) return null;
    voicesLoaded = true;
    // Prefer a high-quality local en-US voice (Apple "Samantha", Google US English).
    return (
      voices.find((v) => v.lang === "en-US" && /samantha|google|apple/i.test(v.name)) ||
      voices.find((v) => v.lang === "en-US" && v.localService) ||
      voices.find((v) => v.lang === "en-US") ||
      voices.find((v) => v.lang && v.lang.startsWith("en")) ||
      null
    );
  }

  function preloadVoices() {
    if (!ttsAvailable) return;
    cachedVoice = pickEnglishVoice();
    try {
      if (typeof window.speechSynthesis.addEventListener === "function") {
        window.speechSynthesis.addEventListener("voiceschanged", () => {
          cachedVoice = pickEnglishVoice();
        });
      } else {
        window.speechSynthesis.onvoiceschanged = () => {
          cachedVoice = pickEnglishVoice();
        };
      }
    } catch (e) {
      // Some WebViews throw when subscribing — non-fatal.
    }
  }

  function buildTtsButton(text) {
    const btn = el("button", {
      class: "tts-btn",
      type: "button",
      "aria-label": `${text} 발음 듣기`,
      title: "발음 듣기",
      onclick: (e) => {
        e.stopPropagation();
        playTts(text);
      },
    });
    btn.textContent = "🔊";
    if (!ttsAvailable) {
      btn.setAttribute("disabled", "");
      btn.title = "이 브라우저에서는 발음 재생을 지원하지 않습니다";
    }
    return btn;
  }

  function speakOnce(text, voice) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 0.95;
    u.pitch = 1;
    u.volume = 1;
    if (voice) u.voice = voice;
    window.speechSynthesis.speak(u);
  }

  function playTts(text) {
    if (!ttsAvailable) return;
    try {
      // Some WebViews freeze the synth if speech is interrupted while paused.
      try { window.speechSynthesis.resume(); } catch (e) {}
      window.speechSynthesis.cancel();

      // If voices are not yet loaded (common in Android KakaoTalk WebView on
      // the very first call), trigger a load and retry shortly.
      if (!cachedVoice) cachedVoice = pickEnglishVoice();
      if (!cachedVoice && typeof window.speechSynthesis.getVoices === "function") {
        // Force voice list to populate (some engines load lazily here).
        try { window.speechSynthesis.getVoices(); } catch (e) {}
        // Retry a couple of times — voices arrive asynchronously.
        let tries = 0;
        const tick = () => {
          cachedVoice = pickEnglishVoice();
          if (cachedVoice || tries >= 6) {
            speakOnce(text, cachedVoice);
          } else {
            tries += 1;
            setTimeout(tick, 120);
          }
        };
        tick();
        return;
      }
      speakOnce(text, cachedVoice);
    } catch (e) {
      console.warn("TTS failed", e);
    }
  }

  // ---------- Answer handling ----------
  function normalizeEnglish(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[’']/g, "'")
      .replace(/[‐-―]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.,;:!?]+$/g, "")
      .trim();
  }

  function isCorrectEnglish(input, word) {
    const norm = normalizeEnglish(input);
    if (!norm) return false;
    if (normalizeEnglish(word.en) === norm) return true;
    if (Array.isArray(word.alt_en)) {
      for (const alt of word.alt_en) {
        if (normalizeEnglish(alt) === norm) return true;
      }
    }
    return false;
  }

  function buildHint(en) {
    let out = "";
    let wordStart = true;
    for (const ch of en) {
      if (/\s/.test(ch)) {
        out += ch;
        wordStart = true;
      } else if (/[A-Za-z]/.test(ch)) {
        if (wordStart) {
          out += ch;
          wordStart = false;
        } else {
          out += "_";
        }
      } else {
        // Non-letter (apostrophe, hyphen, digit) shown as-is.
        out += ch;
      }
    }
    return out;
  }

  function submitTypeA(rawInput) {
    const q = state.quiz;
    if (!q) return;
    const item = q.questions[q.cursor];
    if (item.type !== "A") return;

    const trimmed = String(rawInput || "").trim();
    const correct = isCorrectEnglish(trimmed, item.word);

    if (correct) {
      // Only first-try correct scores as correct.
      const scoredCorrect = item.attempts === 0;
      finalizeTypeA(scoredCorrect, trimmed);
      if (scoredCorrect) {
        showFeedback(true, item.word, trimmed);
      } else {
        showTypeAFeedback({
          kind: "late-correct",
          word: item.word,
          given: trimmed,
          attempts: item.attempts,
        });
      }
      lockTypeAInputs();
      showNextButton();
      return;
    }

    item.attempts += 1;

    if (item.attempts === 1) {
      showTypeAFeedback({
        kind: "wrong-1",
        word: item.word,
        given: trimmed,
        attempts: item.attempts,
      });
      resetTypeAInput();
      return;
    }

    if (item.attempts === 2) {
      showTypeAFeedback({
        kind: "wrong-2",
        word: item.word,
        given: trimmed,
        attempts: item.attempts,
        hint: buildHint(item.word.en),
      });
      resetTypeAInput();
      return;
    }

    // attempts >= 3: reveal.
    finalizeTypeA(false, trimmed);
    showTypeAFeedback({
      kind: "reveal",
      word: item.word,
      given: trimmed,
      attempts: item.attempts,
    });
    lockTypeAInputs();
    showNextButton();
  }

  function revealTypeA() {
    const q = state.quiz;
    if (!q) return;
    const item = q.questions[q.cursor];
    if (item.type !== "A") return;
    item.attempts = MAX_TYPEA_ATTEMPTS;
    finalizeTypeA(false, "");
    showTypeAFeedback({ kind: "reveal", word: item.word, given: "", attempts: item.attempts });
    lockTypeAInputs();
    showNextButton();
  }

  function lockTypeAInputs() {
    const box = $("#questionBox");
    if (!box) return;
    const input = box.querySelector(".q-input");
    if (input) input.setAttribute("disabled", "");
    const submit = box.querySelector(".q-input-row .btn-primary");
    if (submit) submit.setAttribute("disabled", "");
    const reveal = box.querySelector("#revealBtn");
    if (reveal) reveal.setAttribute("disabled", "");
  }

  function resetTypeAInput() {
    const input = $("#questionBox .q-input");
    if (input) {
      input.value = "";
      input.focus();
    }
    // Update attempt dots.
    const item = state.quiz.questions[state.quiz.cursor];
    const wrap = $("#questionBox .q-attempts");
    if (wrap) {
      clear(wrap);
      wrap.appendChild(el("span", { text: `시도 ${item.attempts}/${MAX_TYPEA_ATTEMPTS}` }));
      for (let i = 0; i < MAX_TYPEA_ATTEMPTS; i++) {
        wrap.appendChild(
          el("span", { class: "dot" + (i < item.attempts ? " used" : ""), "aria-hidden": "true" })
        );
      }
    }
  }

  function finalizeTypeA(correct, given) {
    const q = state.quiz;
    const item = q.questions[q.cursor];
    if (item._recorded) return;
    item._recorded = true;
    if (correct) q.correct += 1;
    q.results.push({
      id: item.word.id,
      type: "A",
      en: item.word.en,
      ko: item.word.ko,
      correct,
      given,
      attempts: item.attempts,
    });
  }

  function showTypeAFeedback({ kind, word, given, attempts, hint }) {
    const fb = $("#feedbackBox");
    fb.removeAttribute("hidden");
    clear(fb);
    if (kind === "wrong-1") {
      fb.classList.remove("ok");
      fb.classList.add("bad");
      fb.appendChild(document.createTextNode(`❌ 오답 (시도 ${attempts}/${MAX_TYPEA_ATTEMPTS}). 다시 시도하세요.`));
      if (given) {
        const you = el("span", { class: "reveal", text: `입력: ${given}` });
        fb.appendChild(you);
      }
      return;
    }
    if (kind === "wrong-2") {
      fb.classList.remove("ok");
      fb.classList.add("bad");
      fb.appendChild(document.createTextNode(`❌ 오답 (시도 ${attempts}/${MAX_TYPEA_ATTEMPTS}). `));
      const hintLine = el("span", { class: "reveal" }, [
        document.createTextNode("힌트: "),
        el("span", { class: "hint-mono", text: hint }),
      ]);
      fb.appendChild(hintLine);
      if (given) {
        fb.appendChild(el("span", { class: "reveal", text: `입력: ${given}` }));
      }
      return;
    }
    if (kind === "reveal") {
      fb.classList.remove("ok");
      fb.classList.add("bad");
      const altEn = word.alt_en && word.alt_en.length ? ` (${word.alt_en.join(", ")})` : "";
      fb.appendChild(document.createTextNode(`정답: ${word.en}${altEn}`));
      fb.appendChild(el("span", { class: "reveal", text: `— ${word.ko}` }));
      if (given) {
        fb.appendChild(el("span", { class: "reveal", text: `입력: ${given}` }));
      }
      return;
    }
    if (kind === "late-correct") {
      fb.classList.remove("bad");
      fb.classList.add("ok");
      fb.appendChild(
        document.createTextNode(
          `✓ 맞췄지만 시도 ${attempts}회째라 오답 처리됩니다.`
        )
      );
      fb.appendChild(el("span", { class: "reveal", text: `정답: ${word.en} — ${word.ko}` }));
      return;
    }
  }

  function submitTypeB(choice, btn) {
    const q = state.quiz;
    if (!q) return;
    const item = q.questions[q.cursor];
    if (item._recorded) return;
    const correct = choice === item.word.ko;
    item._recorded = true;
    if (correct) q.correct += 1;
    q.results.push({
      id: item.word.id,
      type: "B",
      en: item.word.en,
      ko: item.word.ko,
      correct,
      given: choice,
      attempts: 1,
    });

    const choiceButtons = $$(".choice", $("#questionBox"));
    choiceButtons.forEach((b) => {
      b.setAttribute("disabled", "");
      const c = b.dataset.choice;
      if (c === item.word.ko) b.classList.add("correct");
      else if (b === btn && !correct) b.classList.add("wrong");
    });

    showFeedback(correct, item.word, choice);
    showNextButton();
  }

  function showFeedback(correct, word, given) {
    const fb = $("#feedbackBox");
    fb.removeAttribute("hidden");
    fb.classList.toggle("ok", correct);
    fb.classList.toggle("bad", !correct);
    clear(fb);
    if (correct) {
      fb.appendChild(document.createTextNode("⭕ 정답!"));
    } else {
      fb.appendChild(document.createTextNode("❌ 오답"));
      const reveal = el("span", { class: "reveal" });
      const altEn = word.alt_en && word.alt_en.length ? ` (${word.alt_en.join(", ")})` : "";
      reveal.textContent = `정답: ${word.en}${altEn} — ${word.ko}`;
      fb.appendChild(reveal);
      if (given) {
        const you = el("span", { class: "reveal" });
        you.textContent = `입력: ${given}`;
        fb.appendChild(you);
      }
    }
  }

  function advance() {
    const q = state.quiz;
    if (!q) return;
    q.cursor += 1;
    if (q.cursor >= q.questions.length) finishQuiz();
    else renderQuestion();
  }

  function showNextButton() {
    const q = state.quiz;
    if (!q) return;
    const isLast = q.cursor === q.questions.length - 1;
    let nextBar = $("#nextBar");
    if (!nextBar) {
      nextBar = el("div", { class: "next-bar", id: "nextBar" });
      $("#questionBox").appendChild(nextBar);
    } else {
      clear(nextBar);
    }
    const btn = el(
      "button",
      {
        class: "btn btn-primary btn-next",
        type: "button",
        id: "nextBtn",
        onclick: advance,
      },
      isLast ? "결과 보기 →" : "다음 →"
    );
    nextBar.appendChild(btn);
    setTimeout(() => btn.focus(), 0);
  }

  // ---------- Finish + persist ----------
  function finishQuiz() {
    const q = state.quiz;
    if (!q) return;
    const total = q.results.length;
    const correct = q.correct;
    const byType = {
      A: { total: 0, correct: 0 },
      B: { total: 0, correct: 0 },
    };
    const wrongIds = [];
    const perWord = {};
    for (const r of q.results) {
      byType[r.type].total += 1;
      if (r.correct) byType[r.type].correct += 1;
      else wrongIds.push(r.id);
      const cur = perWord[r.id] || { seen: 0, wrong: 0 };
      cur.seen += 1;
      if (!r.correct) cur.wrong += 1;
      perWord[r.id] = cur;
    }
    const attempt = {
      ts: Date.now(),
      subjectId: q.subjectId,
      subjectName: q.subjectName,
      total,
      correct,
      byType,
      wrongIds,
    };
    recordAttempt(attempt);
    recordWordStats(perWord);

    renderResult(attempt, q.results);
    setRoute("result");
  }

  function pctText(num, denom) {
    if (denom === 0) return "—";
    return ((num / denom) * 100).toFixed(1) + "%";
  }

  function renderResult(attempt, results) {
    const summary = $("#resultSummary");
    clear(summary);
    summary.appendChild(
      el("div", { class: "result-stat" }, [
        el("div", { class: "label", text: "총점" }),
        el("div", { class: "value", text: `${attempt.correct} / ${attempt.total}` }),
      ])
    );
    summary.appendChild(
      el("div", { class: "result-stat" }, [
        el("div", { class: "label", text: "정답률" }),
        el("div", { class: "value", text: pctText(attempt.correct, attempt.total) }),
      ])
    );
    summary.appendChild(
      el("div", { class: "result-stat" }, [
        el("div", { class: "label", text: "주관식 (한→영)" }),
        el("div", {
          class: "value muted",
          text: `${attempt.byType.A.correct} / ${attempt.byType.A.total} · ${pctText(
            attempt.byType.A.correct,
            attempt.byType.A.total
          )}`,
        }),
      ])
    );
    summary.appendChild(
      el("div", { class: "result-stat" }, [
        el("div", { class: "label", text: "객관식 (영→한)" }),
        el("div", {
          class: "value muted",
          text: `${attempt.byType.B.correct} / ${attempt.byType.B.total} · ${pctText(
            attempt.byType.B.correct,
            attempt.byType.B.total
          )}`,
        }),
      ])
    );

    const wrongList = $("#wrongList");
    clear(wrongList);
    const wrongs = results.filter((r) => !r.correct);
    if (wrongs.length === 0) {
      wrongList.appendChild(el("li", { class: "empty-msg", text: "틀린 문항이 없습니다 🎉" }));
    } else {
      for (const r of wrongs) {
        const right = el("div", { class: "right-col" }, [buildTtsButton(r.en)]);
        const li = el("li", {}, [
          el("div", {}, [
            el("div", { class: "en", text: r.en }),
            el("div", { class: "ko", text: r.ko }),
          ]),
          right,
        ]);
        if (r.given && r.given !== r.en) {
          li.appendChild(el("div", { class: "you", text: `입력: ${r.given || "(빈 입력)"}` }));
        } else if (!r.given) {
          li.appendChild(el("div", { class: "you", text: "입력: (빈 입력)" }));
        }
        wrongList.appendChild(li);
      }
    }
  }

  // ---------- Flashcards ----------
  function openFlashcards(subjectId) {
    const subject = state.subjects[subjectId];
    if (!subject) return;
    const prefs = getFlashcardPrefs();
    state.flashcard = {
      subjectId,
      subjectName: subject.subjectName,
      shuffle: !!prefs.shuffle,
      autoplay: !!prefs.autoplay,
      hideMeaning: !!prefs.hideMeaning,
      filter: prefs.filter || "all",
      index: 0,
      order: [],          // array of words after filter+shuffle
    };
    setRoute("flashcard");
    // Sync UI controls with prefs.
    $("#fcShuffle").checked = state.flashcard.shuffle;
    $("#fcAutoplay").checked = state.flashcard.autoplay;
    $("#fcHideMeaning").checked = state.flashcard.hideMeaning;
    $("#fcFilter").value = state.flashcard.filter;
    rebuildFlashcardOrder();
    renderFlashcard();
  }

  function rebuildFlashcardOrder() {
    const fc = state.flashcard;
    if (!fc) return;
    const subject = state.subjects[fc.subjectId];
    if (!subject) return;
    const bookmarks = getBookmarks();
    const stats = getWordStats();
    let pool = subject.words.slice();
    if (fc.filter === "bookmark") {
      pool = pool.filter((w) => bookmarks[w.id]);
    } else if (fc.filter === "wrong") {
      pool = pool.filter((w) => stats[w.id] && stats[w.id].wrong > 0);
      // sort by wrong count descending so the worst offenders come first.
      pool.sort((a, b) => (stats[b.id].wrong - stats[a.id].wrong));
    }
    if (fc.shuffle && fc.filter !== "wrong") pool = shuffle(pool);
    fc.order = pool;
    if (fc.index >= pool.length) fc.index = 0;
  }

  function persistFlashcardPrefs() {
    const fc = state.flashcard;
    if (!fc) return;
    setFlashcardPrefs({
      shuffle: fc.shuffle,
      autoplay: fc.autoplay,
      hideMeaning: fc.hideMeaning,
      filter: fc.filter,
    });
  }

  function renderFlashcard() {
    const fc = state.flashcard;
    if (!fc) return;
    const total = fc.order.length;
    $("#fcTotal").textContent = String(total);
    $("#fcIndex").textContent = String(total === 0 ? 0 : fc.index + 1);
    $("#fcProgressFill").style.width = total === 0 ? "0%" : `${((fc.index + 1) / total) * 100}%`;

    const stage = $("#fcStage");
    clear(stage);

    if (total === 0) {
      const msg =
        fc.filter === "bookmark"
          ? "북마크한 단어가 없습니다. 카드 우상단의 ★ 버튼으로 추가하세요."
          : fc.filter === "wrong"
            ? "아직 자주 틀린 단어가 없습니다. 퀴즈를 더 풀어보세요."
            : "표시할 단어가 없습니다.";
      stage.appendChild(el("div", { class: "fc-empty", text: msg }));
      $("#fcBookmarkBtn").setAttribute("aria-hidden", "true");
      $("#fcBookmarkBtn").style.visibility = "hidden";
      $("#fcPrevBtn").setAttribute("disabled", "");
      $("#fcNextBtn").setAttribute("disabled", "");
      return;
    }

    $("#fcBookmarkBtn").style.visibility = "visible";
    $("#fcBookmarkBtn").removeAttribute("aria-hidden");
    $("#fcPrevBtn").toggleAttribute("disabled", fc.index === 0);
    $("#fcNextBtn").toggleAttribute("disabled", fc.index >= total - 1);

    const w = fc.order[fc.index];
    const card = buildFlashcardEl(w);
    stage.appendChild(card);
    attachSwipeHandlers(card);

    // Bookmark button reflects current state.
    const bmBtn = $("#fcBookmarkBtn");
    const isBm = isBookmarked(w.id);
    bmBtn.textContent = isBm ? "★" : "☆";
    bmBtn.classList.toggle("active", isBm);
    bmBtn.setAttribute("aria-pressed", isBm ? "true" : "false");
    bmBtn.setAttribute("aria-label", isBm ? `${w.en} 북마크 해제` : `${w.en} 북마크`);

    if (fc.autoplay) playTts(w.en);
  }

  function buildFlashcardEl(w) {
    const card = el("div", { class: "fc-card" + (state.flashcard.hideMeaning ? " meaning-hidden" : "") });
    card.addEventListener("click", (e) => {
      // Tap-to-toggle, but ignore clicks on the TTS button.
      if (e.target.closest(".tts-btn")) return;
      state.flashcard.hideMeaning = !state.flashcard.hideMeaning;
      $("#fcHideMeaning").checked = state.flashcard.hideMeaning;
      persistFlashcardPrefs();
      card.classList.toggle("meaning-hidden", state.flashcard.hideMeaning);
    });

    const enRow = el("div", { class: "fc-en" }, [
      document.createTextNode(w.en),
      buildTtsButton(w.en),
    ]);
    card.appendChild(enRow);
    if (w.alt_en && w.alt_en.length) {
      card.appendChild(el("div", { class: "fc-alt-en", text: w.alt_en.join(" · ") }));
    }
    card.appendChild(el("div", { class: "fc-divider" }));
    card.appendChild(el("div", { class: "fc-ko", text: w.ko }));
    if (w.alt_ko && w.alt_ko.length) {
      card.appendChild(el("div", { class: "fc-alt-ko", text: w.alt_ko.join(" · ") }));
    }
    if (w.note) {
      card.appendChild(el("div", { class: "fc-note", text: w.note }));
    }
    return card;
  }

  // ----- Navigation -----
  function flashcardNext() {
    const fc = state.flashcard;
    if (!fc || fc.index >= fc.order.length - 1) return;
    fc.index += 1;
    renderFlashcard();
  }
  function flashcardPrev() {
    const fc = state.flashcard;
    if (!fc || fc.index <= 0) return;
    fc.index -= 1;
    renderFlashcard();
  }
  function flashcardClose() {
    state.flashcard = null;
    renderHome();
    setRoute("home");
  }

  // ----- Touch swipe handling -----
  let swipeStart = null; // { x, y, t }
  function attachSwipeHandlers(card) {
    const TAP_TOL = 8;
    const SWIPE_THRESHOLD = 60;

    card.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      swipeStart = { x: t.clientX, y: t.clientY, t: Date.now(), dragged: false };
    }, { passive: true });

    card.addEventListener("touchmove", (e) => {
      if (!swipeStart || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - swipeStart.x;
      const dy = t.clientY - swipeStart.y;
      if (!swipeStart.dragged && Math.abs(dx) > TAP_TOL) {
        if (Math.abs(dx) > Math.abs(dy)) swipeStart.dragged = true;
      }
      if (swipeStart.dragged) {
        card.classList.add("dragging");
        card.style.transform = `translateX(${dx}px)`;
        card.style.opacity = String(Math.max(0.3, 1 - Math.abs(dx) / 400));
      }
    }, { passive: true });

    card.addEventListener("touchend", (e) => {
      if (!swipeStart) return;
      const dx = (e.changedTouches[0] || {}).clientX - swipeStart.x;
      const wasDragged = swipeStart.dragged;
      const startState = swipeStart;
      swipeStart = null;
      card.classList.remove("dragging");

      if (!wasDragged) {
        // Treat as a tap — toggle happens on click handler.
        card.style.transform = "";
        card.style.opacity = "";
        return;
      }
      if (Math.abs(dx) >= SWIPE_THRESHOLD) {
        // Animate out.
        if (dx < 0) {
          card.classList.add("swipe-out-left");
          setTimeout(flashcardNext, 180);
        } else {
          card.classList.add("swipe-out-right");
          setTimeout(flashcardPrev, 180);
        }
      } else {
        // Snap back.
        card.style.transition = "transform 0.18s ease, opacity 0.18s ease";
        card.style.transform = "";
        card.style.opacity = "";
      }
      // Prevent the implicit click from firing toggle after a swipe.
      // (Touch-handlers already set dragged so click would still fire on some
      //  browsers; we stop one synthetic click.)
      if (wasDragged) suppressNextClick(card);
    });
  }
  function suppressNextClick(node) {
    const handler = (e) => {
      e.stopPropagation();
      e.preventDefault();
      node.removeEventListener("click", handler, true);
    };
    node.addEventListener("click", handler, true);
  }

  function bindFlashcardControls() {
    $("#fcCloseBtn").addEventListener("click", flashcardClose);
    $("#fcPrevBtn").addEventListener("click", flashcardPrev);
    $("#fcNextBtn").addEventListener("click", flashcardNext);
    $("#fcBookmarkBtn").addEventListener("click", () => {
      const fc = state.flashcard;
      if (!fc || fc.order.length === 0) return;
      const w = fc.order[fc.index];
      toggleBookmark(w.id);
      renderFlashcard();
    });
    $("#fcShuffle").addEventListener("change", (e) => {
      state.flashcard.shuffle = e.target.checked;
      persistFlashcardPrefs();
      rebuildFlashcardOrder();
      state.flashcard.index = 0;
      renderFlashcard();
    });
    $("#fcAutoplay").addEventListener("change", (e) => {
      state.flashcard.autoplay = e.target.checked;
      persistFlashcardPrefs();
    });
    $("#fcHideMeaning").addEventListener("change", (e) => {
      state.flashcard.hideMeaning = e.target.checked;
      persistFlashcardPrefs();
      renderFlashcard();
    });
    $("#fcFilter").addEventListener("change", (e) => {
      state.flashcard.filter = e.target.value;
      persistFlashcardPrefs();
      state.flashcard.index = 0;
      rebuildFlashcardOrder();
      renderFlashcard();
    });
  }

  // ---------- History ----------
  function renderHistory() {
    const attempts = getAttempts();
    const stats = getWordStats();

    const aList = $("#attemptList");
    clear(aList);
    if (attempts.length === 0) {
      aList.appendChild(el("li", { class: "empty-msg", text: "아직 시도 기록이 없습니다." }));
    } else {
      for (const a of attempts.slice(0, 30)) {
        const when = new Date(a.ts);
        const whenText = when.toLocaleString("ko-KR", {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        });
        aList.appendChild(
          el("li", {}, [
            el("div", { class: "row" }, [
              el("span", { class: "subject", text: a.subjectName || a.subjectId }),
              el("span", { class: "score", text: `${a.correct} / ${a.total}` }),
            ]),
            el("div", { class: "row" }, [
              el("span", { class: "when", text: whenText }),
              el("span", { class: "pct", text: pctText(a.correct, a.total) }),
            ]),
          ])
        );
      }
    }

    const fList = $("#freqWrongList");
    clear(fList);
    const top = topWrongWords(stats, 10);
    if (top.length === 0) {
      fList.appendChild(el("li", { class: "empty-msg", text: "충분한 데이터가 아직 없습니다." }));
    } else {
      for (const t of top) {
        fList.appendChild(
          el("li", {}, [
            el("div", { class: "row" }, [
              el("span", { class: "en", text: t.en }),
              el("span", { class: "ratio", text: `${t.wrong} / ${t.seen} 오답` }),
            ]),
            el("div", { class: "ko", text: t.ko }),
          ])
        );
      }
    }
  }

  function topWrongWords(stats, n) {
    const wordIndex = {};
    for (const sid of Object.keys(state.subjects)) {
      for (const w of state.subjects[sid].words) {
        wordIndex[w.id] = w;
      }
    }
    const rows = [];
    for (const [id, s] of Object.entries(stats)) {
      const w = wordIndex[id];
      if (!w || s.seen === 0) continue;
      rows.push({
        id,
        en: w.en,
        ko: w.ko,
        seen: s.seen,
        wrong: s.wrong,
        ratio: s.wrong / s.seen,
      });
    }
    rows.sort((a, b) => {
      if (b.wrong !== a.wrong) return b.wrong - a.wrong;
      return b.ratio - a.ratio;
    });
    return rows.filter((r) => r.wrong > 0).slice(0, n);
  }

  // ---------- Wiring ----------
  function bindGlobalControls() {
    $("#brandBtn").addEventListener("click", () => goHome());
    $$(".navlink").forEach((b) => {
      b.addEventListener("click", () => {
        const r = b.dataset.route;
        if (r === "home") goHome();
        else if (r === "history") goHistory();
      });
    });
    $("#goHistoryBtn").addEventListener("click", goHistory);
    $("#historyBackBtn").addEventListener("click", goHome);
    $("#backHomeBtn").addEventListener("click", goHome);
    $("#retryBtn").addEventListener("click", () => {
      if (state.quiz) startQuiz(state.quiz.subjectId, state.quiz.requestedCount);
    });
    $("#quitQuizBtn").addEventListener("click", quitQuiz);
    $("#resetDataBtn").addEventListener("click", () => {
      if (confirm("학습 기록(시도 기록·자주 틀린 단어)을 모두 삭제할까요?")) {
        clearLearningData();
        renderHome();
        renderHistory();
      }
    });

    // Mode tabs on home.
    $$(".mode-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        state.homeMode = tab.dataset.mode;
        setHomeMode(state.homeMode);
        renderHome();
      });
    });

    bindFlashcardControls();

    document.addEventListener("keydown", (e) => {
      // Flashcard keyboard nav.
      if (state.currentRoute === "flashcard" && state.flashcard) {
        if (e.key === "ArrowRight") { e.preventDefault(); flashcardNext(); return; }
        if (e.key === "ArrowLeft") { e.preventDefault(); flashcardPrev(); return; }
        if (e.key === " " || e.key === "Spacebar") {
          e.preventDefault();
          state.flashcard.hideMeaning = !state.flashcard.hideMeaning;
          $("#fcHideMeaning").checked = state.flashcard.hideMeaning;
          persistFlashcardPrefs();
          renderFlashcard();
          return;
        }
        if (e.key === "s" || e.key === "S") {
          const fc = state.flashcard;
          if (fc.order[fc.index]) playTts(fc.order[fc.index].en);
          return;
        }
        if (e.key === "b" || e.key === "B") {
          const fc = state.flashcard;
          if (fc.order[fc.index]) {
            toggleBookmark(fc.order[fc.index].id);
            renderFlashcard();
          }
          return;
        }
        if (e.key === "Escape") { e.preventDefault(); flashcardClose(); return; }
      }

      if (state.currentRoute !== "quiz" || !state.quiz) return;
      // Enter advances when "다음 →" button is visible.
      if (e.key === "Enter") {
        const nb = $("#nextBtn");
        if (nb && !nb.disabled && document.activeElement !== document.querySelector(".q-input")) {
          e.preventDefault();
          nb.click();
          return;
        }
      }
      const item = state.quiz.questions[state.quiz.cursor];
      if (!item || item.type !== "B") return;
      if (e.key >= "1" && e.key <= "4") {
        const idx = parseInt(e.key, 10) - 1;
        const buttons = $$(".choice", $("#questionBox"));
        const target = buttons[idx];
        if (target && !target.disabled) target.click();
      }
    });
  }

  function goHome() {
    if (state.currentRoute === "quiz" && state.quiz && state.quiz.cursor > 0) {
      if (!confirm("진행 중인 퀴즈를 그만두면 결과가 저장되지 않습니다. 계속할까요?")) return;
    }
    state.quiz = null;
    state.flashcard = null;
    renderHome();
    setRoute("home");
  }
  function goHistory() {
    renderHistory();
    setRoute("history");
  }

  // ---------- Bootstrap ----------
  async function init() {
    state.selectedCount = getStoredCount();
    state.homeMode = getHomeMode();
    preloadVoices();
    maybeShowInAppBanner();
    bindGlobalControls();
    setRoute("home");
    renderModeTabs();
    renderCountPicker();
    const { loaded, errors } = await loadSubjects();
    if (loaded.length === 0) {
      showLoadError(errors.length ? errors : [{ path: "data/", message: "데이터가 비어있습니다." }]);
      return;
    }
    for (const s of loaded) {
      if (!s.subjectId || !Array.isArray(s.words)) continue;
      state.subjects[s.subjectId] = s;
    }
    renderHome();
    if (errors.length) {
      console.warn("일부 과목 로드 실패", errors);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
