/* 간호 단어 퀴즈 — 단일 페이지 SPA */
(function () {
  "use strict";

  // ---------- Constants ----------
  const SUBJECT_FILES = ["data/subject1.json", "data/subject2.json"];
  const COUNT_OPTIONS = [5, 10, 15, 20, 25, 30, 35, 40];
  const DEFAULT_COUNT = 40;
  const MAX_TYPEA_ATTEMPTS = 3; // 1=오답, 2=힌트, 3=정답 공개
  const ATTEMPT_HISTORY_LIMIT = 100;
  const STORAGE_KEYS = {
    attempts: "nursingQuiz.v1.attempts",
    wordStats: "nursingQuiz.v1.wordStats",
    count: "nursingQuiz.v1.count",
  };
  // Auto-advance disabled: user always clicks "다음 →" to proceed.

  // ---------- State ----------
  const state = {
    subjects: {}, // subjectId -> { subjectId, subjectName, version, words[] }
    currentRoute: "home",
    quiz: null, // active quiz session
    selectedCount: DEFAULT_COUNT,
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
    // 학습 기록만 지우고 사용자가 고른 문항 수는 보존.
    localStorage.removeItem(STORAGE_KEYS.attempts);
    localStorage.removeItem(STORAGE_KEYS.wordStats);
  }

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

  function renderHome() {
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
      const card = el("div", { class: "subject-card" }, [
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
      grid.appendChild(card);
    }
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

  // ---------- TTS ----------
  let ttsAvailable =
    typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined" &&
    typeof window.SpeechSynthesisUtterance !== "undefined";

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
    if (!ttsAvailable) btn.setAttribute("disabled", "");
    return btn;
  }

  function playTts(text) {
    if (!ttsAvailable) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      u.rate = 0.95;
      window.speechSynthesis.speak(u);
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

    document.addEventListener("keydown", (e) => {
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
    bindGlobalControls();
    setRoute("home");
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
