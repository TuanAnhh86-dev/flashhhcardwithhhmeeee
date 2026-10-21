(() => {
  'use strict';

  const DEFAULT_DATA_DIR = './lcms-flashcards-2026-10-21T07-39-10Z/';
  const PROGRESS_PREFIX = 'lcms-flashcards-progress-v1:';
  const SESSION_PREFIX = 'lcms-flashcards-session-v1:';
  const PART_NAMES = ['Photographs', 'Question-Response', 'Conversations', 'Talks', 'Incomplete Sentences', 'Text Completion', 'Reading Comprehension'];
  const PART_RANGES = [[1, 6], [7, 31], [32, 70], [71, 100], [101, 130], [131, 146], [147, 200]];
  const ui = Object.fromEntries([
    'choose-data','folder-picker','data-status','exam-filter','part-filter','search-input',
    'shuffle-toggle','export-csv','stat-total','stat-review','stat-known','stat-new',
    'count-all','count-new','count-review','count-known','reset-statuses','deck-title','deck-subtitle',
    'card-position','progress-percent','progress-fill','card-stage','flashcard','flashcard-inner',
    'front-content','back-content','front-type','front-audio-host','back-audio-host','card-front','card-back','empty-state',
    'loading-state','card-controls','previous-card','next-card','flip-card','mark-review',
    'mark-known','restart-session','fullscreen-toggle','study-layout','clear-filters','toast',
    'transcript-dialog','transcript-english','transcript-vietnamese','tun-image-dialog','audio-warning-button','completion-dialog',
    'completion-title','completion-summary','completion-status-body','completion-confetti','completion-restart','completion-iq-launch',
    'start-iq-test','iq-test-dialog','iq-test-setup-view','iq-test-setup-title','iq-test-question-view','iq-test-results-view','iq-test-scope-label','iq-test-position',
    'iq-test-progress-label','iq-test-progress-fill','iq-test-question-body','iq-test-previous','iq-test-next',
    'iq-result-title','iq-result-summary','iq-result-body','iq-test-review','iq-test-retry',
  ].map(id => [id, document.getElementById(id)]));

  let records = [];
  let queue = [];
  let currentIndex = 0;
  let currentStatusFilter = 'all';
  let shuffled = false;
  let dataBaseUrl = null;
  let folderFiles = null;
  let assetObjectUrls = new Map();
  let activeDatasetId = 'default';
  let progress = {};
  let resumeCardKey = '';
  let completionShown = false;
  let iqTest = null;
  let iqReviewSubset = null;
  let previousIqTestKeys = '';
  let toastTimer;

  function decodeHtmlEntities(value) {
    return String(value || '')
      .replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_entity, hex, decimal) => {
        const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
        return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : _entity;
      })
      .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&nbsp;/gi, ' ');
  }

  function normalizeText(value) {
    return decodeHtmlEntities(value).replaceAll('\r', '').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
  }

  function highlightedClozeHtml(passage, question) {
    const safePassage = escapeHtml(passage);
    const number = Number(question);
    const target = new RegExp(`(\\(${number}\\)\\s*)(_{4,})`);
    if (target.test(safePassage)) {
      return safePassage.replace(target, '<mark class="cloze-current">$1$2</mark>');
    }
    return safePassage.replace(`(${number})`, `<mark class="cloze-current">(${number}) __________</mark>`);
  }

  function questionKey(card) { return `${card.exam}-${card.question}`; }

  function loadProgress() {
    try { progress = JSON.parse(localStorage.getItem(PROGRESS_PREFIX + activeDatasetId) || '{}'); }
    catch { progress = {}; }
  }

  function saveProgress() {
    try { localStorage.setItem(PROGRESS_PREFIX + activeDatasetId, JSON.stringify(progress)); }
    catch { showToast('Không lưu được tiến độ trong trình duyệt.', true); }
    updateStats();
  }

  function saveSessionPosition(card) {
    try { localStorage.setItem(SESSION_PREFIX + activeDatasetId, questionKey(card)); }
    catch {}
  }

  function statusOf(card) { return progress[questionKey(card)]?.status || 'new'; }

  function questionStatusClass(card) {
    const status = statusOf(card);
    return status === 'review' ? 'is-review' : status === 'known' ? 'is-known' : '';
  }

  function setDataStatus(message, kind = '') {
    ui['data-status'].textContent = message;
    ui['data-status'].className = `data-status${kind ? ` ${kind}` : ''}`;
  }

  function showToast(message, error = false) {
    ui.toast.textContent = message;
    ui.toast.className = `toast show${error ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.className = 'toast'; }, 2200);
  }

  function partForQuestion(card) {
    let question = Number(card.question);
    if (!Number.isFinite(question) || question < 1 || question > 200) {
      const text = normalizeText(card.pageText || '');
      const passageQuestion = text.match(/Passage for questions?\s+\d+\s*[-–]\s*\d+\s*;\s*question\s+(\d+)/i);
      const numberedQuestion = text.match(/^\s*(\d{1,3})\s*\./);
      question = Number(passageQuestion?.[1] || numberedQuestion?.[1] || NaN);
    }
    const index = PART_RANGES.findIndex(([start, end]) => question >= start && question <= end);
    if (index >= 0) return PART_NAMES[index];
    const text = normalizeText(card.pageText || '');
    const inferred = PART_NAMES.find(name => new RegExp(`(?:^|\\n)\\s*${name}\\s*(?:\\n|$)`, 'i').test(text));
    return inferred || 'Part khác';
  }

  function partLabel(card) {
    const index = PART_NAMES.indexOf(partForQuestion(card));
    return index < 0 ? 'Part khác' : `Part ${index + 1}: ${PART_NAMES[index]}`;
  }

  function cleanTail(raw) {
    let text = normalizeText(raw);
    text = text.replace(/\n(?:Đáp án đúng|Correct answer)\s*[:：].*$/is, '');
    text = text.replace(/\n(?:Photographs|Question-Response|Conversations|Talks|Incomplete Sentences|Text Completion|Reading Comprehension)\s*\n(?:Câu hỏi|Question)\s+\d+[\s\S]*$/i, '');
    text = text.replace(/\nBẢNG TỔNG HỢP[\s\S]*$/i, '');
    return text.trim();
  }

  function isPassageCloze(card) {
    return /^Passage for questions?\s+\d{1,3}\s*[-–]\s*\d{1,3}/i.test(normalizeText(card.pageText || '').trim());
  }

  function groupPassage(raw) {
    let text = normalizeText(raw);
    const reference = text.search(/Questions?\s+\d{1,3}\s*[-–]\s*\d{1,3}\s+refer to the following[^\n]*/i);
    if (reference >= 0) text = text.slice(reference + text.slice(reference).match(/Questions?\s+\d{1,3}\s*[-–]\s*\d{1,3}\s+refer to the following[^\n]*/i)[0].length);
    text = text.replace(/\n(?:Text Completion|Reading Comprehension|Câu hỏi|Question)\s*\n?[\s\S]*$/i, '');
    text = text.replace(/\nBẢNG TỔNG HỢP[\s\S]*$/i, '');
    text = text.replace(/\(\s*(\d{1,3})\s*\)\s*(?:\n\s*)?\([A-D]\)\s*[^\n]*/g, '($1) __________');
    text = text.replace(/^\s*\([A-D]\)\s+[^\n]*$/gm, '');
    return text.trim();
  }

  function part5Prompt(raw, question) {
    let body = cleanTail(normalizeText(raw));
    const numberPattern = new RegExp(`(?:^|\\n)\\s*${Number(question)}\\.\\s*`);
    const start = body.search(numberPattern);
    if (start >= 0) body = body.slice(start).replace(numberPattern, '').trim();
    const firstOption = body.search(/^[\t ]*\([A-D]\)/m);
    let prompt = (firstOption >= 0 ? body.slice(0, firstOption) : body).trim();
    prompt = prompt
      .replace(/([^\s]) {2,}([^\s])/g, '$1 __________ $2')
      .replace(/[\t ]+([,.;!?])/g, ' __________$1');
    if (!/_{4,}/.test(prompt)) prompt = `${prompt} __________`;
    return prompt;
  }

  function parseOptions(raw) {
    const choices = [];
    const regex = /^[\t ]*\(([A-D])\)[\t ]*([^\r\n]*)[\t ]*$/gm;
    for (const match of normalizeText(raw).matchAll(regex)) {
      const letter = match[1].toUpperCase();
      if (!choices.some(choice => choice.letter === letter)) choices.push({ letter, text: match[2].trim() });
    }
    return choices;
  }

  function inlineCandidates(raw, targetQuestion) {
    const text = normalizeText(raw);
    const markers = Array.from(text.matchAll(/\(\s*(\d{1,3})\s*\)/g));
    const marker = markers.find(match => Number(match[1]) === Number(targetQuestion));
    if (!marker) return [];

    const nextMarker = markers.find(match =>
      match.index > marker.index &&
      Number(match[1]) === Number(targetQuestion) + 1
    );
    const segment = text.slice(marker.index + marker[0].length, nextMarker?.index ?? text.length);
    return Array.from(
      segment.matchAll(/(?:^|[\r\n])[ \t]*\(([A-D])\)[ \t]*([^\r\n]*)/g),
      match => ({ letter: match[1].toUpperCase(), text: match[2].trim() }),
    );
  }

  function questionParts(card) {
    const raw = normalizeText(card.pageText || '');
    if (isPassageCloze(card)) {
      return { prompt: normalizeText(card.passageText || groupPassage(raw)), options: [], group: true };
    }
    let body = cleanTail(raw);
    const numberPattern = new RegExp(`(?:^|\\n)\\s*${Number(card.question)}\\.\\s*`);
    const start = body.search(numberPattern);
    if (start >= 0) body = body.slice(start).replace(numberPattern, '').trim();
    const answerStart = body.search(/\n(?:Đáp án đúng|Correct answer)\s*[:：]/i);
    if (answerStart >= 0) body = body.slice(0, answerStart).trim();
    const firstOption = body.search(/^\s*\([A-D]\)\s*/m);
    let prompt = (firstOption >= 0 ? body.slice(0, firstOption) : body).trim();
    if (Number(card.question) >= 101 && Number(card.question) <= 130) {
      prompt = normalizeText(card.promptText || part5Prompt(raw, card.question));
    }
    const options = parseOptions(firstOption >= 0 ? body.slice(firstOption) : '');
    return { prompt, options, group: false };
  }

  function getAnswer(card) {
    const saved = progress[questionKey(card)]?.answerOverride;
    if (saved) return { key: saved.key || '', phrase: saved.phrase || '', custom: true };
    const storedKey = String(card.correctAnswer || '').trim().toUpperCase();
    const raw = normalizeText(card.pageText || '');
    const inline = isPassageCloze(card) ? inlineCandidates(raw, card.question) : [];
    const key = storedKey || (inline.length > 1 ? inline.at(-1).letter : '');
    let phrase = '';
    if (isPassageCloze(card)) {
      phrase = normalizeText(card.correctAnswerText || inline.find(option => option.letter === key)?.text || '');
    } else {
      const option = questionParts(card).options.find(choice => choice.letter === key);
      phrase = normalizeText(card.correctAnswerText || option?.text || '');
      const explicit = raw.match(/(?:Đáp án đúng|Correct answer)\s*[:：]?\s*\(([A-D])\)\s*([^\n]*)/i);
      if (!phrase && explicit && explicit[1].toUpperCase() === key && explicit[2].trim()) phrase = explicit[2].trim();
    }
    return { key, phrase, custom: false };
  }

  function quizAnswerOptions(card, parts = questionParts(card), answer = getAnswer(card)) {
    const transcriptOptions = parseOptions(card.transcript?.en || '');
    const part = partForQuestion(card);
    const letterOnly = part === 'Photographs' || part === 'Question-Response';
    const allowedLetters = part === 'Question-Response' ? ['A', 'B', 'C'] : ['A', 'B', 'C', 'D'];
    if (letterOnly) return allowedLetters.map(letter => ({ letter, text: '' }));
    const limitOptions = choices => choices.filter(option => allowedLetters.includes(option.letter));
    let options = parts.group ? [] : parts.options;
    if ((!options.some(option => option.letter === answer.key && option.text) || options.length < 2) &&
        transcriptOptions.some(option => option.letter === answer.key && option.text)) {
      options = transcriptOptions;
    }
    options = limitOptions(options);
    if (options.length >= 2 && options.some(option => option.letter === answer.key && option.text)) {
      return options.slice(0, allowedLetters.length).map(option => letterOnly ? { ...option, text: '' } : option);
    }

    const candidateTexts = [];
    if (parts.group) {
      candidateTexts.push(...inlineCandidates(card.pageText || '', card.question).map(option => option.text));
      const groupCards = records.filter(item => item.exam === card.exam && item.questionGroup && item.questionGroup === card.questionGroup);
      candidateTexts.push(...groupCards.filter(item => questionKey(item) !== questionKey(card)).map(item => getAnswer(item).phrase));
    }
    candidateTexts.push(...options.map(option => option.text), ...transcriptOptions.map(option => option.text));
    candidateTexts.push(...records.filter(item => questionKey(item) !== questionKey(card)).map(item => getAnswer(item).phrase));

    const distractors = [...new Set(candidateTexts.map(text => normalizeText(text).trim()).filter(text => text && text !== answer.phrase))];
    const key = allowedLetters.includes(answer.key) ? answer.key : 'A';
    const letters = allowedLetters;
    let distractorIndex = 0;
    return letters.map(letter => ({
      letter,
      text: letterOnly ? '' : letter === key ? (answer.phrase || 'Đáp án đúng') : (distractors[distractorIndex++] || '—'),
    }));
  }

  async function readJsonFile(file) { return JSON.parse(await file.text()); }

  function validateAndInstall(examEntries, datasetId, sourceInfo) {
    iqTest = null;
    iqReviewSubset = null;
    records = examEntries.flatMap(({ exam, rows, source }) => rows.map(row => ({
      ...row, exam: Number(row.exam || exam), question: Number(row.question), _source: source,
    }))).sort((a, b) => a.exam - b.exam || a.question - b.question);
    activeDatasetId = datasetId;
    loadProgress();
    try { resumeCardKey = localStorage.getItem(SESSION_PREFIX + activeDatasetId) || ''; }
    catch { resumeCardKey = ''; }
    const counts = [1, 2].map(exam => records.filter(row => row.exam === exam).length);
    const complete = counts.every((count, index) => count === 200 && records.filter(row => row.exam === index + 1).every((row, rowIndex) => row.question === rowIndex + 1));
    setDataStatus(`${records.length} thẻ · ${counts[0]}/200 câu đề 1 · ${counts[1]}/200 câu đề 2${complete ? '' : ' · dữ liệu chưa đủ 200 câu'}`, complete ? 'success' : 'warning');
    populatePartFilter();
    ui['loading-state'].hidden = true;
    ui['card-controls'].hidden = false;
    rebuildQueue(false);
    ui['deck-subtitle'].textContent = `${counts[0]} câu đề 1 · ${counts[1]} câu đề 2`;
    if (sourceInfo) ui['data-status'].title = sourceInfo;
    const missing = records.filter(card => (partForQuestion(card) === 'Photographs' || /Look at the graphic|Saludos Hispanos Magazine/i.test(card.pageText || '')) && !(card.images || []).length);
    if (missing.length) {
      const details = [1, 2].map(exam => {
        const nums = missing.filter(card => card.exam === exam).map(card => card.question);
        return nums.length ? `Đề ${exam}: ${nums.join(', ')}` : '';
      }).filter(Boolean).join('; ');
      setDataStatus(`${records.length} thẻ · ${missing.length} thẻ thiếu ảnh`, 'warning');
      ui['data-status'].title = `${sourceInfo || ''}\nThiếu ảnh: ${details}`.trim();
    }
  }

  async function loadDefaultData() {
    ui['loading-state'].hidden = false;
    ui['card-controls'].hidden = true;
    try {
      const examEntries = await Promise.all([1, 2].map(async exam => {
        const source = `${DEFAULT_DATA_DIR}exam-${String(exam).padStart(2, '0')}/questions.json`;
        const response = await fetch(source, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Không mở được ${source} (${response.status})`);
        return { exam, rows: await response.json(), source };
      }));
      dataBaseUrl = new URL(DEFAULT_DATA_DIR, location.href).href;
      folderFiles = null;
      validateAndInstall(examEntries, 'oct-21-073910z-2-exams', `Nguồn: ${DEFAULT_DATA_DIR}`);
    } catch (error) {
      ui['loading-state'].hidden = true;
      ui['empty-state'].hidden = false;
      ui['empty-state'].querySelector('h2').textContent = 'Chưa mở được bộ dữ liệu';
      ui['empty-state'].querySelector('p').textContent = 'Chọn thư mục có exam-01 và exam-02 để nạp câu hỏi, ảnh và âm thanh.';
      setDataStatus('Không tìm thấy bộ dữ liệu mặc định. Hãy chọn thư mục kết quả trích xuất.', 'error');
      showToast(error.message, true);
    }
  }

  async function loadSelectedFolder(files) {
    const fileList = [...files];
    if (!fileList.length) return;
    const questionFiles = new Map();
    const assetFiles = new Map();
    let folderName = 'local-import';
    for (const file of fileList) {
      const relative = (file.webkitRelativePath || file.name).replaceAll('\\', '/');
      const questionMatch = relative.match(/(?:^|\/)exam-0?([12])\/questions\.json$/i);
      if (questionMatch) {
        questionFiles.set(Number(questionMatch[1]), file);
        const pieces = relative.split('/');
        folderName = pieces.length > 1 ? pieces[0] : folderName;
      }
      const assetMatch = relative.match(/(?:^|\/)exam-0?([12])\/(assets\/.*)$/i);
      if (assetMatch) assetFiles.set(`${Number(assetMatch[1])}/${assetMatch[2]}`, file);
    }
    if (!questionFiles.has(1) || !questionFiles.has(2)) {
      setDataStatus('Thư mục cần có exam-01/questions.json và exam-02/questions.json.', 'error');
      showToast('Chưa thấy đủ questions.json của hai đề.', true);
      return;
    }
    try {
      const examEntries = await Promise.all([1, 2].map(async exam => ({ exam, rows: await readJsonFile(questionFiles.get(exam)), source: null })));
      for (const url of assetObjectUrls.values()) URL.revokeObjectURL(url);
      assetObjectUrls = new Map();
      folderFiles = assetFiles;
      dataBaseUrl = null;
      validateAndInstall(examEntries, `folder:${folderName}`, `Nguồn cục bộ: ${folderName}`);
      showToast('Đã nạp dữ liệu và tệp media.');
    } catch (error) {
      setDataStatus(`Không đọc được JSON: ${error.message}`, 'error');
      showToast('Có lỗi khi đọc questions.json.', true);
    }
  }

  function getAssetUrl(card, item) {
    if (!item) return '';
    if (folderFiles) {
      const relative = item.localFile ? `${card.exam}/${item.localFile.replace(/^\.\//, '')}` : '';
      const file = folderFiles.get(relative);
      if (file) {
        if (!assetObjectUrls.has(relative)) assetObjectUrls.set(relative, URL.createObjectURL(file));
        return assetObjectUrls.get(relative);
      }
    }
    if (item.localFile && dataBaseUrl) {
      const examDir = new URL(`exam-${String(card.exam).padStart(2, '0')}/`, dataBaseUrl);
      return new URL(item.localFile.replace(/^\.\//, ''), examDir).href;
    }
    return item.url || '';
  }

  function populatePartFilter() {
    const current = ui['part-filter'].value || 'all';
    ui['part-filter'].replaceChildren(new Option('Tất cả phần', 'all'));
    PART_NAMES.forEach((name, index) => ui['part-filter'].add(new Option(`Part ${index + 1}: ${name}`, name)));
    ui['part-filter'].value = [...ui['part-filter'].options].some(option => option.value === current) ? current : 'all';
  }

  function filteredRecords() {
    const exam = ui['exam-filter'].value;
    const part = ui['part-filter'].value;
    const search = ui['search-input'].value.trim().toLowerCase();
    return (iqReviewSubset || records).filter(card => {
      if (exam !== 'all' && card.exam !== Number(exam)) return false;
      if (part !== 'all' && partForQuestion(card) !== part) return false;
      if (currentStatusFilter !== 'all' && statusOf(card) !== currentStatusFilter) return false;
      if (search) {
        const answer = getAnswer(card);
        const haystack = `${card.question} ${card.exam} ${card.pageText || ''} ${answer.key} ${answer.phrase}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    });
  }

  function rebuildQueue(keepCurrent = true) {
    const oldKey = keepCurrent && queue[currentIndex] ? questionKey(queue[currentIndex]) : '';
    queue = filteredRecords();
    if (shuffled) queue = queue.map(card => ({ card, sort: Math.random() })).sort((a, b) => a.sort - b.sort).map(row => row.card);
    const preferredKey = oldKey || resumeCardKey;
    const preserved = preferredKey ? queue.findIndex(card => questionKey(card) === preferredKey) : -1;
    resumeCardKey = '';
    currentIndex = preserved >= 0 ? preserved : Math.min(currentIndex, Math.max(0, queue.length - 1));
    if (currentIndex < queue.length - 1) completionShown = false;
    renderCard();
    updateStats();
  }

  function clearIqReviewSubset() {
    if (!iqReviewSubset) return false;
    iqReviewSubset = null;
    return true;
  }

  function updateStats() {
    const counts = { all: records.length, new: 0, review: 0, known: 0 };
    for (const card of records) counts[statusOf(card)] = (counts[statusOf(card)] || 0) + 1;
    ui['count-all'].textContent = counts.all;
    ui['count-new'].textContent = counts.new;
    ui['count-review'].textContent = counts.review;
    ui['count-known'].textContent = counts.known;
    ui['stat-total'].textContent = counts.all;
    ui['stat-new'].textContent = counts.new;
    ui['stat-review'].textContent = counts.review;
    ui['stat-known'].textContent = counts.known;
  }

  function setStatusFilter(status) {
    clearIqReviewSubset();
    currentStatusFilter = status;
    document.querySelectorAll('.status-option').forEach(button => button.classList.toggle('active', button.dataset.status === status));
    currentIndex = 0;
    rebuildQueue(false);
  }

  function resetAllStatuses() {
    let resetCount = 0;
    for (const card of records) {
      const key = questionKey(card);
      const entry = progress[key];
      if (!entry || !Object.hasOwn(entry, 'status')) continue;
      delete entry.status;
      if (!Object.keys(entry).length) delete progress[key];
      resetCount += 1;
    }
    saveProgress();
    setStatusFilter('new');
    showToast(resetCount
      ? `Đã đưa ${resetCount} thẻ về trạng thái Chưa học.`
      : 'Tất cả thẻ đã ở trạng thái Chưa học.');
  }

  function makeOptions(options, correctKey = '') {
    const rows = options.length ? options : ['A', 'B', 'C', 'D'].map(letter => ({ letter, text: '' }));
    const list = document.createElement('div');
    list.className = 'question-options';
    for (const option of rows) {
      const chip = document.createElement('div');
      chip.className = `option-chip${correctKey && option.letter === correctKey ? ' is-correct' : ''}`;
      chip.innerHTML = `<span class="option-letter">(${escapeHtml(option.letter)})</span><span>${escapeHtml(option.text || ' ')}</span>`;
      list.append(chip);
    }
    return list;
  }

  function renderMedia(card) {
    ui['front-audio-host'].replaceChildren();
    ui['back-audio-host'].replaceChildren();
    const media = (card.media || []).filter(item => !(Number(card.question) > 100 && item.kind === 'audio'));
    const audioItems = media.filter(item => item.kind === 'audio');
    for (const item of audioItems) {
      const src = getAssetUrl(card, item);
      if (!src) continue;
      const strip = document.createElement('div');
      strip.className = 'audio-strip';
      strip.innerHTML = '<span class="audio-label">AUDIO</span>';
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = src;
      audio.setAttribute('aria-label', `Audio đề ${card.exam}, câu ${card.question}`);
      const releaseAudioFocus = () => requestAnimationFrame(() => audio.blur());
      audio.addEventListener('pointerup', releaseAudioFocus);
      audio.addEventListener('play', releaseAudioFocus);
      audio.addEventListener('pause', releaseAudioFocus);
      strip.append(audio);
      const transcriptEnglish = normalizeText(card.transcript?.en || '').trim();
      if (transcriptEnglish && Number(card.question) <= 100) {
        const showTranscript = document.createElement('button');
        showTranscript.className = 'transcript-open-button';
        showTranscript.type = 'button';
        showTranscript.textContent = 'Show trans';
        showTranscript.setAttribute('aria-haspopup', 'dialog');
        showTranscript.addEventListener('click', () => {
          ui['transcript-english'].textContent = transcriptEnglish;
          ui['transcript-vietnamese'].textContent = normalizeText(card.transcript?.vi || '').trim() || 'Chưa có bản dịch.';
          ui['transcript-dialog'].showModal();
        });
        strip.append(showTranscript);
      }
      ui['front-audio-host'].append(strip);
    }
    return { media, audioItems };
  }

  function renderVisuals(card, media) {
    const stack = document.createElement('div');
    stack.className = 'visual-stack';
    const seen = new Set();
    const assets = [...(card.images || []), ...media.filter(item => item.kind === 'image' || item.kind === 'video')];
    for (const asset of assets) {
      const src = getAssetUrl(card, asset);
      const identity = asset.localFile || asset.url || src;
      if (!src || seen.has(identity)) continue;
      seen.add(identity);
      const element = asset.kind === 'video' ? document.createElement('video') : document.createElement('img');
      element.src = src;
      element.alt = asset.alt || `Đề ${card.exam}, câu ${card.question}`;
      if (element.tagName === 'VIDEO') { element.controls = true; element.preload = 'metadata'; }
      stack.append(element);
    }
    return stack;
  }

  function renderFront(card, parts, answer, media) {
    const columns = document.createElement('div');
    columns.className = 'card-columns';
    const visual = document.createElement('div');
    visual.className = 'visual-column';
    visual.append(renderVisuals(card, media));
    if (!visual.querySelector('img,video')) columns.classList.add('no-visual');
    const content = document.createElement('div');
    content.className = 'answer-column';
    const heading = document.createElement('div');
    heading.className = 'question-heading';
    const number = document.createElement('span');
    number.className = `question-number ${questionStatusClass(card)}`.trim();
    number.textContent = `#${card.question}`;
    const prompt = document.createElement('div');
    prompt.className = 'question-prompt';
    prompt.textContent = parts.group ? `Điền vào chỗ trống · câu ${card.question}` : (parts.prompt || 'Câu hỏi chưa có nội dung văn bản.');
    heading.append(number, prompt);
    content.append(heading);
    if (parts.group && parts.prompt) {
      const passage = document.createElement('div');
      passage.className = 'group-text';
      passage.innerHTML = highlightedClozeHtml(parts.prompt, card.question);
      content.append(passage);
    }
    if (!parts.group) content.append(makeOptions(parts.options, ''));
    columns.append(visual, content);
    ui['front-content'].replaceChildren(columns);
  }

  function saveAnswerOverride(card, key, phrase) {
    const normalizedKey = key.trim().toUpperCase();
    if (normalizedKey && !/^[A-D]$/.test(normalizedKey)) {
      showToast('Đáp án phải là A, B, C hoặc D.', true);
      return;
    }
    const entry = progress[questionKey(card)] || {};
    entry.answerOverride = { key: normalizedKey, phrase: phrase.trim() };
    progress[questionKey(card)] = entry;
    saveProgress();
    renderBack(card);
    showToast('Đã lưu đáp án sửa trên trình duyệt này.');
  }

  function renderBack(card) {
    const answer = getAnswer(card);
    const wrapper = document.createElement('div');
    wrapper.className = 'answer-column answer-details';
    const banner = document.createElement('div');
    banner.className = 'answer-banner';
    banner.innerHTML = `<small>Đáp án đúng</small><strong>${escapeHtml(answer.key ? `(${answer.key}) ` : '')}${escapeHtml(answer.phrase || 'Chưa có nội dung đáp án')}</strong>${answer.custom ? '<span class="custom-answer-tag">Đã sửa · lưu cục bộ</span>' : ''}`;
    wrapper.append(banner);
    const button = document.createElement('button');
    button.className = 'edit-answer-button';
    button.type = 'button';
    button.textContent = answer.custom ? 'Sửa đáp án trên thiết bị này' : 'Sửa đáp án';
    wrapper.append(button);
    const form = document.createElement('form');
    form.className = 'answer-edit-form';
    form.hidden = true;
    form.innerHTML = `<label>Đáp án <select class="answer-letter-input" aria-label="Chữ cái đáp án"><option value="">Không rõ</option><option>A</option><option>B</option><option>C</option><option>D</option></select></label><input class="answer-phrase-input" aria-label="Nội dung đáp án" placeholder="Nội dung đáp án"><button class="save-answer-button" type="submit">Lưu</button><button class="reset-answer-button" type="button">Khôi phục đáp án gốc</button>`;
    form.querySelector('select').value = answer.key;
    form.querySelector('.answer-phrase-input').value = answer.phrase;
    button.addEventListener('click', () => { form.hidden = !form.hidden; if (!form.hidden) form.querySelector('select').focus(); });
    form.addEventListener('submit', event => {
      event.preventDefault();
      saveAnswerOverride(card, form.querySelector('select').value, form.querySelector('.answer-phrase-input').value);
    });
    form.querySelector('.reset-answer-button').addEventListener('click', () => {
      const entry = progress[questionKey(card)];
      if (entry) delete entry.answerOverride;
      saveProgress();
      renderBack(card);
      showToast('Đã khôi phục đáp án trong dữ liệu gốc.');
    });
    wrapper.append(form);
    const note = document.createElement('textarea');
    note.className = 'note-field';
    note.placeholder = 'Ghi chú của bạn…';
    note.setAttribute('aria-label', 'Ghi chú cho thẻ này');
    note.value = progress[questionKey(card)]?.note || '';
    note.addEventListener('change', () => {
      const entry = progress[questionKey(card)] || {};
      entry.note = note.value;
      progress[questionKey(card)] = entry;
      saveProgress();
      showToast('Đã lưu ghi chú trên trình duyệt.');
    });
    wrapper.append(note);
    ui['back-content'].replaceChildren(wrapper);
  }

  function renderCard() {
    ui['empty-state'].hidden = queue.length > 0;
    ui['flashcard'].hidden = queue.length === 0;
    if (!queue.length) {
      ui['card-position'].textContent = '0 / 0';
      ui['progress-fill'].style.width = '0%';
      ui['deck-title'].textContent = 'Không có thẻ phù hợp';
      return;
    }
    const card = queue[currentIndex];
    saveSessionPosition(card);
    const parts = questionParts(card);
    const answer = getAnswer(card);
    const { media, audioItems } = renderMedia(card);
    ui['flashcard'].classList.remove('flipped');
    ui['card-back'].setAttribute('aria-hidden', 'true');
    ui['card-front'].setAttribute('aria-hidden', 'false');
    ui['deck-title'].textContent = `Đề ${card.exam} · ${partLabel(card)}`;
    ui['card-position'].textContent = `${currentIndex + 1} / ${queue.length} · Đề ${card.exam}, câu ${card.question}`;
    const percent = Math.round(((currentIndex + 1) / queue.length) * 100);
    ui['progress-fill'].style.width = `${percent}%`;
    ui['progress-percent'].textContent = `${percent}%`;
    ui['front-type'].textContent = partForQuestion(card).toUpperCase();
    renderFront(card, parts, answer, media);
    renderBack(card);
    requestAnimationFrame(() => {
      for (const audio of ui['front-audio-host'].querySelectorAll('audio')) audio.play().catch(() => {});
    });
  }

  function flipCard() {
    if (!queue.length) return;
    const flipped = ui['flashcard'].classList.toggle('flipped');
    ui['card-back'].setAttribute('aria-hidden', String(!flipped));
    ui['card-front'].setAttribute('aria-hidden', String(flipped));
  }

  function renderCompletionAssessment(cards) {
    const counts = { known: 0, review: 0, new: 0 };
    for (const card of cards) counts[statusOf(card)] += 1;
    const total = cards.length;
    const exam = ui['exam-filter'].value;
    const rows = [
      ['known', 'Đã nhớ'],
      ['review', 'Chưa nhớ'],
      ['new', 'Chưa học'],
    ];
    ui['completion-title'].textContent = exam === 'all' ? `Hoàn thành ${total} câu!` : `Hoàn thành ${total} câu đề ${exam}!`;
    ui['completion-summary'].textContent = exam === 'all'
      ? 'Đây là trạng thái hiện tại của thẻ trong cả hai đề.'
      : `Đây là trạng thái hiện tại của ${total} thẻ đề ${exam}.`;
    ui['completion-status-body'].replaceChildren(...rows.map(([status, label]) => {
      const row = document.createElement('tr');
      row.dataset.status = status;
      const name = document.createElement('td');
      name.textContent = label;
      const count = document.createElement('td');
      count.textContent = counts[status];
      const percent = document.createElement('td');
      percent.textContent = `${total ? Math.round(counts[status] / total * 100) : 0}%`;
      row.append(name, count, percent);
      return row;
    }));
  }

  function launchConfetti() {
    const colors = ['#a8cf83', '#f0d37c', '#91d2ff', '#f19ac2', '#d6b5ff', '#ffad75'];
    const pieces = Array.from({ length: 76 }, (_, index) => {
      const piece = document.createElement('i');
      piece.className = 'confetti-piece';
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.animationDelay = `${Math.random() * 650}ms`;
      piece.style.animationDuration = `${2800 + Math.random() * 1700}ms`;
      piece.style.setProperty('--drift', `${Math.round((Math.random() - 0.5) * 150)}px`);
      piece.style.setProperty('--spin', `${360 + Math.floor(Math.random() * 720)}deg`);
      piece.style.backgroundColor = colors[index % colors.length];
      return piece;
    });
    ui['completion-confetti'].replaceChildren(...pieces);
    window.setTimeout(() => ui['completion-confetti'].replaceChildren(), 6000);
  }

  function completionScopeCards() {
    if (iqReviewSubset) return null;
    const exam = ui['exam-filter'].value;
    const cards = exam === 'all' ? records : records.filter(card => card.exam === Number(exam));
    const expectedCount = exam === 'all' ? 400 : 200;
    if (cards.length !== expectedCount || queue.length !== expectedCount) return null;
    const queueKeys = new Set(queue.map(questionKey));
    return cards.every(card => queueKeys.has(questionKey(card))) ? cards : null;
  }

  function showCompletionAssessment(cards) {
    renderCompletionAssessment(cards);
    ui['completion-dialog'].showModal();
    launchConfetti();
  }

  function moveCard(amount) {
    if (!queue.length) return;
    const finishedScope = amount > 0 && currentIndex === queue.length - 1 ? completionScopeCards() : null;
    if (finishedScope && !completionShown) {
      completionShown = true;
      showCompletionAssessment(finishedScope);
      return;
    }
    currentIndex = (currentIndex + amount + queue.length) % queue.length;
    if (currentIndex < queue.length - 1) completionShown = false;
    renderCard();
  }

  function quizQuestionPool(examScope = 'all') {
    const source = examScope === 'all' ? records : records.filter(card => card.exam === Number(examScope));
    return source.map(card => {
      const parts = questionParts(card);
      const answer = getAnswer(card);
      return { card, parts, answer, options: quizAnswerOptions(card, parts, answer) };
    }).filter(item => {
      const letterOnly = ['Photographs', 'Question-Response'].includes(partForQuestion(item.card));
      return item.answer.key && item.options.length >= 2 &&
        item.options.some(option => option.letter === item.answer.key &&
          (letterOnly || (option.text && option.text !== '—')));
    });
  }

  function openIqTestSetup() {
    ui['iq-test-dialog'].setAttribute('aria-labelledby', 'iq-test-setup-title');
    ui['iq-test-setup-view'].hidden = false;
    ui['iq-test-question-view'].hidden = true;
    ui['iq-test-results-view'].hidden = true;
    if (!ui['iq-test-dialog'].open) ui['iq-test-dialog'].showModal();
  }

  function startIqTest(examScope) {
    const pool = quizQuestionPool(examScope);
    if (pool.length < 15) {
      showToast(`Chỉ tìm thấy ${pool.length} câu có đủ lựa chọn để làm bài test.`, true);
      return;
    }
    let selected = [];
    let signature = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const shuffledPool = pool.slice();
      for (let index = shuffledPool.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(Math.random() * (index + 1));
        [shuffledPool[index], shuffledPool[swapIndex]] = [shuffledPool[swapIndex], shuffledPool[index]];
      }
      selected = shuffledPool.slice(0, 15);
      signature = selected.map(item => questionKey(item.card)).sort().join('|');
      if (signature !== previousIqTestKeys) break;
    }
    previousIqTestKeys = signature;
    iqTest = { questions: selected, answers: {}, index: 0, examScope };
    for (const audio of [...ui['front-audio-host'].querySelectorAll('audio'), ...ui['back-audio-host'].querySelectorAll('audio')]) audio.pause();
    ui['iq-test-dialog'].setAttribute('aria-labelledby', 'iq-test-title');
    ui['iq-test-scope-label'].textContent = `15 CÂU NGẪU NHIÊN · ${examScope === 'all' ? 'CẢ HAI ĐỀ' : `ĐỀ ${examScope}`}`;
    ui['iq-test-setup-view'].hidden = true;
    ui['iq-test-question-view'].hidden = false;
    ui['iq-test-results-view'].hidden = true;
    renderIqQuestion();
    if (!ui['iq-test-dialog'].open) ui['iq-test-dialog'].showModal();
  }

  function renderIqQuestion() {
    if (!iqTest) return;
    const item = iqTest.questions[iqTest.index];
    const { card, parts, options } = item;
    const number = iqTest.index + 1;
    const answered = Object.keys(iqTest.answers).length;
    const progressPercent = Math.round(answered / iqTest.questions.length * 100);
    ui['iq-test-position'].textContent = `Câu ${number} / ${iqTest.questions.length} · Đề ${card.exam}, câu ${card.question}`;
    ui['iq-test-progress-label'].textContent = `${answered} / ${iqTest.questions.length} đã làm`;
    ui['iq-test-progress-fill'].style.width = `${progressPercent}%`;

    const body = document.createElement('div');
    body.className = 'iq-question-layout';
    const media = (card.media || []).filter(asset => !(Number(card.question) > 100 && asset.kind === 'audio'));
    const audioAssets = media.filter(asset => asset.kind === 'audio');
    for (const asset of audioAssets) {
      const src = getAssetUrl(card, asset);
      if (!src) continue;
      const strip = document.createElement('div');
      strip.className = 'audio-strip iq-question-audio';
      const label = document.createElement('span');
      label.className = 'audio-label';
      label.textContent = 'AUDIO';
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = src;
      audio.setAttribute('aria-label', `Audio đề ${card.exam}, câu ${card.question}`);
      strip.append(label, audio);
      body.append(strip);
    }

    const columns = document.createElement('div');
    columns.className = 'iq-question-columns';
    const visuals = renderVisuals(card, media);
    const hasVisuals = visuals.childElementCount > 0;
    columns.classList.toggle('no-visual', !hasVisuals);
    if (hasVisuals) columns.append(visuals);
    const content = document.createElement('div');
    content.className = 'iq-question-content';
    const heading = document.createElement('div');
    heading.className = 'iq-question-heading';
    const badge = document.createElement('span');
    badge.className = 'question-number';
    badge.textContent = `#${card.question}`;
    const prompt = document.createElement('div');
    prompt.className = 'question-prompt';
    prompt.textContent = parts.group ? `Điền vào chỗ trống · câu ${card.question}` : (parts.prompt || 'Chọn đáp án đúng.');
    heading.append(badge, prompt);
    content.append(heading);
    if (parts.group && parts.prompt) {
      const passage = document.createElement('div');
      passage.className = 'group-text';
      passage.innerHTML = highlightedClozeHtml(parts.prompt, card.question);
      content.append(passage);
    }

    const choiceList = document.createElement('div');
    choiceList.className = 'iq-answer-options';
    const letterOnly = ['Photographs', 'Question-Response'].includes(partForQuestion(card));
    const selectedKey = iqTest.answers[questionKey(card)] || '';
    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `iq-answer-option${selectedKey === option.letter ? ' is-selected' : ''}${letterOnly ? ' is-letter-only' : ''}`;
      button.setAttribute('aria-pressed', String(selectedKey === option.letter));
      const letter = document.createElement('span');
      letter.className = 'option-letter';
      letter.textContent = `(${option.letter})`;
      button.append(letter);
      if (!letterOnly) {
        const text = document.createElement('span');
        text.textContent = option.text;
        button.append(text);
      }
      button.addEventListener('click', () => {
        iqTest.answers[questionKey(card)] = option.letter;
        for (const choice of choiceList.querySelectorAll('.iq-answer-option')) {
          const isSelected = choice === button;
          choice.classList.toggle('is-selected', isSelected);
          choice.setAttribute('aria-pressed', String(isSelected));
        }
        const answeredCount = Object.keys(iqTest.answers).length;
        ui['iq-test-progress-label'].textContent = `${answeredCount} / ${iqTest.questions.length} đã làm`;
        ui['iq-test-progress-fill'].style.width = `${Math.round(answeredCount / iqTest.questions.length * 100)}%`;
        ui['iq-test-next'].disabled = false;
      });
      choiceList.append(button);
    }
    content.append(choiceList);
    columns.append(content);
    body.append(columns);
    ui['iq-test-question-body'].replaceChildren(body);

    ui['iq-test-previous'].disabled = iqTest.index === 0;
    ui['iq-test-next'].textContent = iqTest.index === iqTest.questions.length - 1 ? 'Nộp bài' : 'Câu tiếp';
    ui['iq-test-next'].disabled = !iqTest.answers[questionKey(card)];
  }

  function renderIqResults() {
    if (!iqTest) return;
    const score = iqTest.questions.reduce((total, item) => total + (iqTest.answers[questionKey(item.card)] === item.answer.key ? 1 : 0), 0);
    ui['iq-result-title'].textContent = `Bạn đạt ${score} / ${iqTest.questions.length} câu`;
    const scopeLabel = iqTest.examScope === 'all' ? 'cả hai đề' : `đề ${iqTest.examScope}`;
    ui['iq-result-summary'].textContent = `Đúng ${Math.round(score / iqTest.questions.length * 100)}% · 15 câu được rút từ ${scopeLabel}.`;
    ui['iq-result-body'].replaceChildren(...iqTest.questions.map((item, index) => {
      const { card, options, answer } = item;
      const selectedKey = iqTest.answers[questionKey(card)] || '';
      const selectedOption = options.find(option => option.letter === selectedKey);
      const correctOption = options.find(option => option.letter === answer.key);
      const letterOnly = ['Photographs', 'Question-Response'].includes(partForQuestion(card));
      const optionLabel = option => option && (letterOnly ? `(${option.letter})` : `(${option.letter}) ${option.text}`);
      const correct = selectedKey === answer.key;
      const row = document.createElement('tr');
      row.dataset.result = correct ? 'correct' : 'incorrect';
      const values = [
        String(index + 1),
        `Đề ${card.exam} · Câu ${card.question}`,
        selectedOption ? optionLabel(selectedOption) : 'Chưa chọn',
        correctOption ? optionLabel(correctOption) : `(${answer.key}) ${answer.phrase}`,
        correct ? 'Đúng' : 'Sai',
      ];
      for (const value of values) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      return row;
    }));
    ui['iq-test-dialog'].setAttribute('aria-labelledby', 'iq-result-title');
    ui['iq-test-question-view'].hidden = true;
    ui['iq-test-results-view'].hidden = false;
  }

  function reviewIqTest() {
    if (!iqTest) return;
    iqReviewSubset = iqTest.questions.map(item => item.card);
    ui['iq-test-dialog'].close();
    ui['exam-filter'].value = 'all';
    ui['part-filter'].value = 'all';
    ui['search-input'].value = '';
    currentStatusFilter = 'all';
    document.querySelectorAll('.status-option').forEach(button => button.classList.toggle('active', button.dataset.status === 'all'));
    shuffled = false;
    ui['shuffle-toggle'].setAttribute('aria-pressed', 'false');
    currentIndex = 0;
    completionShown = false;
    rebuildQueue(false);
    showToast('Đang ôn lại 15 câu vừa làm.');
  }

  function markCard(status) {
    if (!queue.length) return;
    const card = queue[currentIndex];
    const entry = progress[questionKey(card)] || {};
    entry.status = status;
    progress[questionKey(card)] = entry;
    saveProgress();
    showToast(status === 'review' ? 'Đã đưa vào mục Chưa nhớ.' : 'Đã đưa vào mục Đã nhớ.');
    moveCard(1);
  }

  function exportQueueCsv() {
    const rows = [['Exam', 'Part', 'Question', 'Prompt', 'Answer', 'Answer text', 'Transcript (EN)', 'Vietnamese translation', 'Status', 'Note']];
    for (const card of queue) {
      const answer = getAnswer(card);
      rows.push([card.exam, partLabel(card), card.question, questionParts(card).prompt, answer.key, answer.phrase, card.transcript?.en || '', card.transcript?.vi || '', statusOf(card), progress[questionKey(card)]?.note || '']);
    }
    const csv = rows.map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'lcms-flashcards-filtered.csv';
    link.click();
    URL.revokeObjectURL(link.href);
    showToast(`Đã tải ${queue.length} thẻ CSV.`);
  }

  function toggleImageFullscreen(event) {
    const image = event.target.closest?.('.visual-stack img');
    if (!image) return;
    event.preventDefault();
    if (document.fullscreenElement === image) document.exitFullscreen?.();
    else image.requestFullscreen?.().catch(() => showToast('Trình duyệt không hỗ trợ toàn màn hình.', true));
  }

  function setFocusMode(active) {
    ui['study-layout'].classList.toggle('fullscreen-mode', active);
    ui['fullscreen-toggle'].classList.toggle('fullscreen-exit', active);
    ui['fullscreen-toggle'].textContent = active ? '×' : '⛶';
    ui['fullscreen-toggle'].title = active ? 'Thoát chế độ toàn màn hình' : 'Chế độ toàn màn hình';
    ui['fullscreen-toggle'].setAttribute('aria-label', ui['fullscreen-toggle'].title);
    ui['fullscreen-toggle'].setAttribute('aria-pressed', String(active));
  }

  function initEvents() {
    ui['choose-data'].addEventListener('click', () => ui['folder-picker'].click());
    ui['audio-warning-button'].addEventListener('click', () => ui['tun-image-dialog'].showModal());
    ui['tun-image-dialog'].addEventListener('click', event => {
      if (event.target === ui['tun-image-dialog']) ui['tun-image-dialog'].close();
    });
    ui['folder-picker'].addEventListener('change', event => loadSelectedFolder(event.target.files));
    ui['exam-filter'].addEventListener('change', () => { clearIqReviewSubset(); currentIndex = 0; rebuildQueue(false); });
    ui['part-filter'].addEventListener('change', () => { clearIqReviewSubset(); currentIndex = 0; rebuildQueue(false); });
    ui['search-input'].addEventListener('input', () => { clearIqReviewSubset(); currentIndex = 0; rebuildQueue(false); });
    document.querySelectorAll('.status-option').forEach(button => button.addEventListener('click', () => setStatusFilter(button.dataset.status)));
    ui['shuffle-toggle'].addEventListener('click', () => {
      clearIqReviewSubset();
      shuffled = !shuffled;
      ui['shuffle-toggle'].setAttribute('aria-pressed', String(shuffled));
      currentIndex = 0;
      rebuildQueue(false);
      showToast(shuffled ? 'Đã trộn thứ tự thẻ.' : 'Đã xếp thẻ theo số câu.');
    });
    ui['flip-card'].addEventListener('click', flipCard);
    ui['previous-card'].addEventListener('click', () => moveCard(-1));
    ui['next-card'].addEventListener('click', () => moveCard(1));
    ui['mark-review'].addEventListener('click', () => markCard('review'));
    ui['mark-known'].addEventListener('click', () => markCard('known'));
    ui['reset-statuses'].addEventListener('click', resetAllStatuses);
    ui['start-iq-test'].addEventListener('click', openIqTestSetup);
    ui['completion-iq-launch'].addEventListener('click', () => {
      ui['completion-dialog'].close();
      openIqTestSetup();
    });
    document.querySelectorAll('[data-iq-test-scope]').forEach(button => button.addEventListener('click', () => startIqTest(button.dataset.iqTestScope)));
    ui['iq-test-previous'].addEventListener('click', () => {
      if (!iqTest || iqTest.index === 0) return;
      iqTest.index -= 1;
      renderIqQuestion();
    });
    ui['iq-test-next'].addEventListener('click', () => {
      if (!iqTest) return;
      const card = iqTest.questions[iqTest.index].card;
      if (!iqTest.answers[questionKey(card)]) return;
      if (iqTest.index === iqTest.questions.length - 1) renderIqResults();
      else {
        iqTest.index += 1;
        renderIqQuestion();
      }
    });
    ui['iq-test-review'].addEventListener('click', reviewIqTest);
    ui['iq-test-retry'].addEventListener('click', () => startIqTest(iqTest?.examScope || 'all'));
    ui['completion-restart'].addEventListener('click', () => {
      ui['completion-dialog'].close();
      currentIndex = 0;
      completionShown = false;
      renderCard();
    });
    ui['restart-session'].addEventListener('click', () => { currentIndex = 0; completionShown = false; renderCard(); showToast('Đã quay về thẻ đầu tiên.'); });
    ui['export-csv'].addEventListener('click', exportQueueCsv);
    ui['clear-filters'].addEventListener('click', () => {
      ui['exam-filter'].value = 'all';
      ui['part-filter'].value = 'all';
      ui['search-input'].value = '';
      setStatusFilter('all');
    });
    ui['fullscreen-toggle'].addEventListener('click', () => {
      setFocusMode(!ui['study-layout'].classList.contains('fullscreen-mode'));
    });
    ui['front-content'].addEventListener('dblclick', toggleImageFullscreen);
    ui['back-content'].addEventListener('dblclick', toggleImageFullscreen);
    ui['iq-test-question-body'].addEventListener('dblclick', toggleImageFullscreen);
    window.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      const isArrowKey = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key);
      if (target.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      if (ui['iq-test-dialog'].open && event.key !== 'Escape') return;
      if (ui['completion-dialog'].open && event.key !== 'Escape') return;
      if (ui['transcript-dialog'].open && isArrowKey) {
        event.preventDefault();
        ui['transcript-dialog'].close();
      } else if (ui['transcript-dialog'].open && event.key !== 'Escape') {
        return;
      }
      if (target.closest?.('video') && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') flipCard();
        else markCard(event.key === 'ArrowLeft' ? 'review' : 'known');
        return;
      }
      if (event.code === 'Space') {
        event.preventDefault();
        event.stopPropagation();
        flipCard();
        return;
      }
      if (!isArrowKey && target.closest?.('audio,video,a,button')) return;
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        flipCard();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        markCard('review');
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        markCard('known');
      } else if (event.key.toLowerCase() === 'f') {
        setFocusMode(!ui['study-layout'].classList.contains('fullscreen-mode'));
      }
    }, true);
  }

  initEvents();
  loadDefaultData();
})();
