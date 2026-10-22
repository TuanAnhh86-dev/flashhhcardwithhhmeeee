#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { env, stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const TARGET_HOST = 'student.dtphanoi.i-school.vn';
const MAX_QUESTIONS = 200;
const MAX_ASSET_BYTES = 30 * 1024 * 1024;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const URLS_FILE = path.join(SCRIPT_DIR, 'exam-urls.txt');
const EDGE_PROFILE_DIR = env.LCMS_EXTRACTOR_PROFILE_DIR || path.join(
  env.LOCALAPPDATA || env.USERPROFILE || SCRIPT_DIR,
  'LCMSExtractor',
  'EdgeProfile',
);

const rl = readline.createInterface({ input, output });

function questionCounter(text) {
  const match = text.match(/(?:câu hỏi|questions?)\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*(?:của|of)\s*(\d+)/i);
  return match ? {
    current: Number(match[1]),
    end: Number(match[2] || match[1]),
    total: Number(match[3]),
  } : null;
}

function inferQuestionRange(text) {
  const numbers = Array.from(text.matchAll(/^[ \t]*(\d{1,3})\.\s+\S.*$/gm), match => Number(match[1]));
  if (!numbers.length) return null;
  return {
    current: Math.min(...numbers),
    end: Math.max(...numbers),
    total: MAX_QUESTIONS,
  };
}

function pageFingerprint(snapshot) {
  // Question text is the stable signal available on pages without a footer counter.
  return snapshot.bodyText;
}

function inlineAnswersForQuestion(text, number, lastQuestion) {
  const questionMarkers = Array.from(text.matchAll(/\(\s*(\d{1,3})\s*\)/g));
  const marker = questionMarkers.find(match => Number(match[1]) === number);
  if (!marker) return [];

  const nextMarker = questionMarkers.find(match =>
    match.index > marker.index &&
    Number(match[1]) > number &&
    Number(match[1]) <= lastQuestion
  );
  const segment = text.slice(marker.index + marker[0].length, nextMarker?.index ?? text.length);
  return Array.from(
    segment.matchAll(/(?:^|[\r\n])[ \t]*\(([A-D])\)[ \t]*([^\r\n]*)/g),
    match => ({ letter: match[1].toUpperCase(), text: match[2].trim() }),
  );
}

function normalizeInlineText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function annotationForQuestion(segment, annotations) {
  const normalizedSegment = normalizeInlineText(segment);
  return annotations
    .filter(annotation => annotation.tone === 'correct' && normalizedSegment.includes(normalizeInlineText(annotation.text)))
    .sort((left, right) => left.text.length - right.text.length)[0] || null;
}

function answerDataForQuestion(text, number, lastQuestion, annotations) {
  const answers = inlineAnswersForQuestion(text, number, lastQuestion);
  const markers = Array.from(text.matchAll(/\(\s*(\d{1,3})\s*\)/g));
  const marker = markers.find(match => Number(match[1]) === number);
  const nextMarker = markers.find(match => match.index > marker?.index && Number(match[1]) > number && Number(match[1]) <= lastQuestion);
  const segment = marker ? text.slice(marker.index + marker[0].length, nextMarker?.index ?? text.length) : '';
  const annotation = annotationForQuestion(segment, annotations);
  const selected = annotation || answers.at(-1) || null;
  const allAnswers = annotation && !answers.some(answer => answer.letter === annotation.letter)
    ? [...answers, { letter: annotation.letter, text: annotation.phrase }]
    : answers;
  return {
    answers: allAnswers,
    segment,
    correctAnswer: selected?.letter || '',
    correctAnswerText: annotation?.phrase || selected?.text || '',
    correctAnnotation: annotation,
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeAnnotatedAnswer(text, annotation) {
  if (!annotation) return text;
  const phrasePattern = annotation.phrase.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
  const pattern = new RegExp(`(?:→\\s*)?\\(${annotation.letter}\\)[ \\t\\r\\n]+${phrasePattern}`, 'g');
  return text.replace(pattern, '');
}

function passageTextWithBlanks(text, counter, annotations) {
  let passage = text.replaceAll('\r', '');
  const heading = passage.match(/Questions?\s+\d{1,3}\s*[-–]\s*\d{1,3}\s+refer to the following[^\n]*\n/i);
  if (heading) passage = passage.slice(heading.index + heading[0].length);
  passage = passage.replace(/\n(?:Text Completion|Reading Comprehension)\s*\n(?:Câu hỏi|Questions?)\s+[\s\S]*$/i, '');
  passage = passage.replace(/\nBẢNG TỔNG HỢP[\s\S]*$/i, '').trim();

  const markers = Array.from(passage.matchAll(/\(\s*(\d{1,3})\s*\)/g))
    .filter(match => Number(match[1]) >= counter.current && Number(match[1]) <= counter.end);
  for (let index = markers.length - 1; index >= 0; index -= 1) {
    const marker = markers[index];
    const number = Number(marker[1]);
    const nextMarker = markers[index + 1];
    const segmentEnd = nextMarker?.index ?? passage.length;
    const segment = passage.slice(marker.index + marker[0].length, segmentEnd);
    const answerData = answerDataForQuestion(passage, number, counter.end, annotations);
    let cleaned = segment;

    for (const answer of answerData.answers) {
      if (answer.letter === answerData.correctAnswer) continue;
      const wrongLine = new RegExp(`(^|\\n)[ \\t]*\\(${answer.letter}\\)[ \\t]*${escapeRegExp(answer.text)}[ \\t]*(?=\\n|$)`, 'g');
      cleaned = cleaned.replace(wrongLine, '$1');
    }
    cleaned = removeAnnotatedAnswer(cleaned, answerData.correctAnnotation);
    cleaned = cleaned.replace(/(?:→|➜)[ \\t]*/g, '');
    cleaned = cleaned.replace(/^[ \\t]*\r?\n[ \\t]*/, ' ');
    passage = `${passage.slice(0, marker.index)}(${number}) __________${cleaned}${passage.slice(segmentEnd)}`;
  }
  return passage.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function part5Block(block) {
  const optionIndex = block.pageText.search(/(?:^|\n)[ \t]*\(A\)/);
  const splitAt = optionIndex < 0 ? block.pageText.length : optionIndex;
  const head = block.pageText.slice(0, splitAt);
  const tail = block.pageText.slice(splitAt);
  const match = head.match(/^([ \t]*\d{1,3}\.\s*)([\s\S]*)$/);
  if (!match) return block;
  let promptText = match[2]
    .replace(/([^\s]) {2,}([^\s])/g, '$1 __________ $2')
    .replace(/[ \t]+([,.;!?])/g, ' __________$1')
    .trim();
  if (!/_{4,}/.test(promptText)) promptText = `${promptText} __________`;
  return {
    ...block,
    promptText,
    pageText: `${match[1]}${promptText}${tail}`,
  };
}

function splitQuestionBlocks(text, counter, inlineAnswerElements = []) {
  const normalized = text.replaceAll('\r', '');
  const matches = Array.from(normalized.matchAll(/^[ \t]*(\d{1,3})\.\s+\S.*$/gm));
  const blocksByNumber = new Map();

  for (let index = 0; index < matches.length; index += 1) {
    const number = Number(matches[index][1]);
    if (number < counter.current || number > counter.end) continue;
    const start = matches[index].index;
    const end = matches[index + 1]?.index ?? normalized.length;
    const blockText = normalized.slice(start, end).trim();
    if (blockText) {
      const block = { number, pageText: blockText, questionGroup: counter.current !== counter.end ? `${counter.current}-${counter.end}` : null };
      blocksByNumber.set(number, number >= 101 && number <= 130 ? part5Block(block) : block);
    }
  }

  // When a Part 6 answer is wrong, the page lists the selected choice followed by the correct one.
  const inlineQuestions = Array.from(normalized.matchAll(/\(\s*(\d{1,3})\s*\)/g));
  for (const match of inlineQuestions) {
    const number = Number(match[1]);
    if (number < counter.current || number > counter.end) continue;
    const answerData = answerDataForQuestion(normalized, number, counter.end, inlineAnswerElements);
    if (!answerData.answers.length) continue;
    const correctAnswer = answerData.correctAnswer;
    const existing = blocksByNumber.get(number);
    if (existing) {
      existing.correctAnswer = correctAnswer;
      existing.correctAnswerText = answerData.correctAnswerText;
      existing.passageText = passageTextWithBlanks(normalized, counter, inlineAnswerElements);
    } else {
      blocksByNumber.set(number, {
        number,
        questionGroup: `${counter.current}-${counter.end}`,
        correctAnswer,
        correctAnswerText: answerData.correctAnswerText,
        passageText: passageTextWithBlanks(normalized, counter, inlineAnswerElements),
        pageText: `Passage for questions ${counter.current}-${counter.end}; question ${number}\n\n${normalized.trim()}`,
      });
    }
  }

  return Array.from(blocksByNumber.values()).sort((left, right) => left.number - right.number);
}
function extensionFrom(url, mimeType, fallback) {
  const mime = (mimeType || '').split(';')[0].trim().toLowerCase();
  const byMime = new Map([
    ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/gif', '.gif'],
    ['image/webp', '.webp'], ['image/svg+xml', '.svg'],
    ['audio/mpeg', '.mp3'], ['audio/mp3', '.mp3'], ['audio/ogg', '.ogg'],
    ['audio/wav', '.wav'], ['audio/x-wav', '.wav'], ['audio/mp4', '.m4a'],
    ['video/mp4', '.mp4'], ['video/webm', '.webm'],
  ]);
  if (byMime.has(mime)) return byMime.get(mime);

  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if (/^\.(jpe?g|png|gif|webp|svg|mp3|ogg|wav|m4a|mp4|webm)$/.test(ext)) return ext;
  } catch {}
  return fallback;
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function answerFromText(text) {
  const match = text.match(/(?:đáp án đúng|correct answer)\s*[:：]?\s*\(?([A-D])\)?/i);
  return match?.[1]?.toUpperCase() ?? '';
}

function validateExamUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`URL không hợp lệ: ${value}`); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== TARGET_HOST || parsed.username || parsed.password) {
    throw new Error(`Chỉ chấp nhận URL HTTPS trên ${TARGET_HOST}.`);
  }
  return parsed.href;
}

async function loadExamUrls() {
  let contents = '';
  try {
    contents = await readFile(URLS_FILE, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const fromFile = contents.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  let values = fromFile;
  if (values.length > 0) {
    if (values.length > 2) throw new Error('exam-urls.txt chỉ được chứa tối đa 2 URL đề.');
    console.log(`Đọc ${values.length} URL từ exam-urls.txt.`);
    if (values.length === 1) console.log('Muốn lấy đề thứ hai, thêm URL đề đó vào dòng trống tiếp theo trong exam-urls.txt.');
  } else {
    console.log('Dán URL tại dấu nhắc nếu được; trong Windows Terminal thường dùng chuột phải hoặc Ctrl+Shift+V.');
    values = [];
    for (let number = 1; number <= 2; number += 1) {
      const value = (await rl.question(`URL đề ${number}${number === 2 ? ' (để trống nếu chỉ lấy một đề)' : ''}: `)).trim();
      if (!value && number === 2) break;
      values.push(value);
    }
  }

  return values.map(validateExamUrl);
}

function hasQuestionContent(text) {
  return /(?:câu hỏi|questions?)\s*\d+(?:\s*[-–]\s*\d+)?\s*(?:của|of)\s*\d+/i.test(text) ||
    /^[ \t]*\d{1,3}\.\s+\S/m.test(text);
}

async function findQuestionFrame(page, perFrameTimeout = 500) {
  const frames = [...page.frames()].sort((left, right) => {
    const leftIsPractice = /i-test4u\.vn\/thirdparty\/practice-test/i.test(left.url());
    const rightIsPractice = /i-test4u\.vn\/thirdparty\/practice-test/i.test(right.url());
    return Number(rightIsPractice) - Number(leftIsPractice);
  });
  const matches = await Promise.all(frames.map(async frame => {
    try {
      const text = await frame.locator('body').innerText({ timeout: perFrameTimeout });
      return hasQuestionContent(text) ? frame : null;
    } catch {
      return null;
    }
  }));
  return matches.find(Boolean) ?? null;
}

async function waitForVisibleImages(page, timeout = 2500) {
  const frame = await findQuestionFrame(page) ?? page.mainFrame();
  try {
    await frame.evaluate(() => {
      for (const image of document.querySelectorAll('img')) {
        const rect = image.getBoundingClientRect();
        const style = getComputedStyle(image);
        if (rect.width >= 80 && rect.height >= 80 && style.display !== 'none' && style.visibility !== 'hidden') {
          image.loading = 'eager';
        }
      }
    });
    await frame.waitForFunction(() => {
      const visibleImages = Array.from(document.querySelectorAll('img')).filter(image => {
        const rect = image.getBoundingClientRect();
        const style = getComputedStyle(image);
        return rect.width >= 80 && rect.height >= 80 && style.display !== 'none' && style.visibility !== 'hidden';
      });
      return visibleImages.every(image => image.complete);
    }, null, { timeout });
  } catch {}
}

async function inspectQuestion(page) {
  const frame = await findQuestionFrame(page) ?? page.mainFrame();
  await waitForVisibleImages(page);
  return frame.evaluate(() => {
    const bodyText = document.body?.innerText ?? '';
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };

    const images = [];
    for (const element of document.querySelectorAll('img')) {
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) continue;
      const url = element.currentSrc || element.src;
      if (url) images.push({ url, alt: element.alt || '' });
    }

    for (const element of document.querySelectorAll('body *')) {
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 100) continue;
      const background = getComputedStyle(element).backgroundImage;
      if (!background || background === 'none') continue;
      for (const match of background.matchAll(/url\(["']?(.*?)["']?\)/g)) {
        if (match[1]) images.push({ url: new URL(match[1], location.href).href, alt: 'background image' });
      }
    }

    const media = [];
    for (const element of document.querySelectorAll('audio,video')) {
      const urls = [element.currentSrc, element.src, ...Array.from(element.querySelectorAll('source'), source => source.src)].filter(Boolean);
      for (const url of urls) media.push({ url, kind: element.tagName.toLowerCase() === 'video' ? 'video' : 'audio' });
    }

    const mediaPattern = /\.(?:mp3|m4a|ogg|wav|mp4|webm)(?:[?#]|$)|audio|sound|listen/i;
    for (const entry of performance.getEntriesByType('resource')) {
      if ((entry.initiatorType === 'audio' || entry.initiatorType === 'video' || mediaPattern.test(entry.name)) && entry.name.startsWith('http')) {
        media.push({ url: entry.name, kind: entry.initiatorType === 'video' ? 'video' : 'audio' });
      }
    }

    const inlineAnswerElements = [];
    for (const element of document.querySelectorAll('body *')) {
      if (!visible(element)) continue;
      const text = (element.innerText || '').replace(/\s+/g, ' ').trim();
      const match = text.match(/^(?:→\s*)?\(([A-D])\)\s*(\S[\s\S]*)$/);
      if (!match || text.length > 100) continue;
      const style = getComputedStyle(element);
      const rgb = style.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      const red = rgb ? Number(rgb[1]) : 0;
      const green = rgb ? Number(rgb[2]) : 0;
      const blue = rgb ? Number(rgb[3]) : 0;
      const decoration = style.textDecorationLine || style.textDecoration || '';
      const tone = /line-through/i.test(decoration) || (red > green * 1.25 && red > blue * 1.2)
        ? 'wrong'
        : green > red * 1.15 && green > blue * 1.15
          ? 'correct'
          : '';
      if (!tone) continue;
      inlineAnswerElements.push({
        text,
        letter: match[1].toUpperCase(),
        phrase: match[2].trim(),
        tone,
      });
    }

    const controls = Array.from(document.querySelectorAll('button,[role="button"],a,[tabindex],[onclick]'))
      .concat(Array.from(document.querySelectorAll('body *')).filter(element => getComputedStyle(element).cursor === 'pointer'))
      .filter((element, index, all) => all.indexOf(element) === index)
      .filter(visible)
      .map(element => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          text: [element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText, element.textContent]
            .filter(Boolean).join(' ').trim().replace(/\s+/g, ' ').slice(0, 100),
          disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          cursor: getComputedStyle(element).cursor,
        };
      });

    const counterMatch = bodyText.match(/(?:câu hỏi|questions?)\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*(?:của|of)\s*(\d+)/i);
    return {
      pageUrl: location.href,
      title: document.title,
      bodyText,
      counter: counterMatch ? {
        current: Number(counterMatch[1]),
        end: Number(counterMatch[2] || counterMatch[1]),
        total: Number(counterMatch[3]),
      } : null,
      images: Array.from(new Map(images.map(item => [item.url, item])).values()),
      media: Array.from(new Map(media.map(item => [item.url, item])).values()),
      inlineAnswerElements: Array.from(new Map(inlineAnswerElements.map(item => [`${item.tone}:${item.text}`, item])).values()),
      controls,
    };
  });
}

async function captureListeningScript(page) {
  const frame = await findQuestionFrame(page);
  if (!frame) return '';

  const openScriptLink = async () => {
    for (const candidateFrame of page.frames()) {
      try {
        const opened = await candidateFrame.evaluate(() => {
          const allElements = [];
          const scan = root => {
            for (const element of root.querySelectorAll('*')) {
              allElements.push(element);
              if (element.shadowRoot) scan(element.shadowRoot);
            }
          };
          scan(document);
          const visible = element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          };
          const candidates = allElements
            .filter(element => element.matches('button,a,[role="button"],[onclick]') || getComputedStyle(element).cursor === 'pointer')
            .filter(visible)
          .map(element => ({ element, text: [element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText, element.textContent].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() }))
            .filter(item => /nội dung bài nghe/i.test(item.text))
            .sort((left, right) => left.text.length - right.text.length);
          if (!candidates.length) return false;
          candidates[0].element.click();
          return true;
        });
        if (opened) return true;
      } catch {}
    }
    return false;
  };

  let opened = await openScriptLink();
  if (!opened) {
    try {
      const audioIconIndex = await frame.evaluate(() => Array.from(document.querySelectorAll('svg')).findIndex(element =>
        /AudioPlayer_sound|AudioProgress_icon/i.test(String(element.parentElement?.className?.baseVal || element.parentElement?.className || ''))
      ));
      if (audioIconIndex >= 0) {
        const audioIcon = frame.locator('svg').nth(audioIconIndex);
        await audioIcon.hover({ timeout: 2500, force: true });
        for (let attempt = 0; attempt < 5 && !opened; attempt += 1) {
          await page.waitForTimeout(120);
          opened = await openScriptLink();
        }
        if (!opened) await audioIcon.click({ timeout: 2500, force: true });
        for (let attempt = 0; attempt < 12 && !opened; attempt += 1) {
          await page.waitForTimeout(120);
          opened = await openScriptLink();
        }
      }
    } catch {}
  }
  if (!opened) return '';

  let transcript = '';
  for (let attempt = 0; attempt < 24 && !transcript; attempt += 1) {
    await page.waitForTimeout(125);
    for (const candidateFrame of page.frames()) {
      try {
        transcript = await candidateFrame.evaluate(() => {
          const title = 'Nội dung bài nghe';
          const allElements = [];
          const scan = root => {
            for (const element of root.querySelectorAll('*')) {
              allElements.push(element);
              if (element.shadowRoot) scan(element.shadowRoot);
            }
          };
          scan(document);
          const visible = element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          };
          const modalElements = Array.from(document.querySelectorAll('[class*="AudioPlayer_modal-content"], .ReactModal__Content'))
            .filter(visible)
            .map(element => ({
              text: (element.innerText || '').trim(),
              rect: element.getBoundingClientRect(),
            }))
            .filter(item => item.text.length > title.length + 10)
            .sort((left, right) => left.text.length - right.text.length);
          if (modalElements.length) {
            let text = modalElements[0].text.replace(/^Basic Modal\s*/i, '').trim();
            const titleIndex = text.toLowerCase().lastIndexOf(title.toLowerCase());
            if (titleIndex >= 0) text = text.slice(titleIndex + title.length).trim();
            return text.replace(/^[×x]\s*/, '').replace(/\s*[×x]$/, '').trim();
          }
          const candidates = allElements
            .filter(visible)
            .map(element => {
              const rect = element.getBoundingClientRect();
              return { text: (element.innerText || '').trim(), rect };
            })
            .filter(item => item.rect.width < innerWidth * 0.98 && item.rect.height < innerHeight * 0.98 && item.text.length > title.length + 10);
          const titled = candidates
            .filter(item => item.text.toLowerCase().includes(title.toLowerCase()))
            .filter(item => /(?:#\s*\d+|number\s+\d+)/i.test(item.text))
            .sort((left, right) => left.text.length - right.text.length || left.rect.width * left.rect.height - right.rect.width * right.rect.height);
          let text = titled[0]?.text || '';
          if (text) {
            const titleIndex = text.toLowerCase().lastIndexOf(title.toLowerCase());
            text = text.slice(titleIndex + title.length).trim();
          } else {
            const transcriptCandidates = candidates
              .filter(item => /(?:^|\n)number\s+\d+\b/i.test(item.text))
              .sort((left, right) => left.text.length - right.text.length);
            text = transcriptCandidates[0]?.text || '';
          }
          return text.replace(/^[×x]\s*/, '').replace(/\s*[×x]$/, '').trim();
        });
      } catch {}
      if (transcript) break;
    }
  }

  let closed = false;
  for (const candidateFrame of page.frames()) {
    try {
      closed = await candidateFrame.evaluate(() => {
        const allElements = [];
        const scan = root => {
          for (const element of root.querySelectorAll('*')) {
            allElements.push(element);
            if (element.shadowRoot) scan(element.shadowRoot);
          }
        };
        scan(document);
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const candidates = allElements
          .filter(element => element.matches('button,a,[role="button"],[aria-label],[title]'))
          .filter(visible)
          .map(element => {
            const rect = element.getBoundingClientRect();
            const label = [element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText, element.textContent]
              .filter(Boolean).join(' ').trim();
            return { element, label, rect };
          })
          .filter(item => /^(?:×|x|close|đóng)$/i.test(item.label) || /(?:close|đóng)/i.test(item.label))
          .sort((left, right) => (left.rect.top + left.rect.left) - (right.rect.top + right.rect.left));
        if (!candidates.length) return false;
        candidates[0].element.click();
        return true;
      });
    } catch {}
    if (closed) break;
  }
  if (!closed) {
    try { await page.keyboard.press('Escape'); } catch {}
  }
  await page.waitForTimeout(100);
  return transcript;
}

async function waitForExamContent(page, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = await findQuestionFrame(page);
    if (frame) return frame;
    await page.waitForTimeout(400);
  }
  throw new Error(`Không thấy câu hỏi trong bất kỳ frame nào sau ${timeout / 1000} giây.`);
}

async function describePageFrames(page) {
  return Promise.all(page.frames().map(async (frame, index) => {
    let text = '';
    try {
      text = await frame.locator('body').innerText({ timeout: 1500 });
    } catch (error) {
      text = `[Không đọc được nội dung: ${error.message}]`;
    }
    return { index, url: frame.url(), name: frame.name(), bodyText: text.slice(0, 2500) };
  }));
}

async function clickQuestionButton(page, side) {
  const frame = await findQuestionFrame(page);
  if (!frame) {
    return { ok: false, reason: 'Could not locate the frame that contains the current question.' };
  }

  let candidates;
  try {
    candidates = await frame.evaluate(() => Array.from(document.querySelectorAll('svg'))
      .map((element, index) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          index,
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          visible: rect.width > 0 && rect.height > 0 && rect.bottom <= innerHeight + 2 &&
            style.visibility !== 'hidden' && style.display !== 'none',
          cursor: style.cursor,
        };
      })
      .filter(item => item.visible && item.y > innerHeight * 0.72 &&
        item.x > innerWidth * 0.45 && item.width >= 40 && item.width <= 140 &&
        item.height >= 25 && item.height <= 80)
      .sort((left, right) => left.x - right.x));
  } catch (error) {
    return { ok: false, frameUrl: frame.url(), reason: `Could not inspect the practice-test frame: ${error.message}` };
  }

  if (!candidates.length) {
    return {
      ok: false,
      frameUrl: frame.url(),
      reason: 'The question frame is present, but no footer arrow SVG matched its visible bounds.',
      candidates,
    };
  }

  const target = side === 'next' ? candidates.at(-1) : candidates[0];
  try {
    // Use browser input inside the same cross-origin iframe as the exam UI.
    await frame.locator('svg').nth(target.index).click({ timeout: 5000, force: true });
    return { ok: true, method: 'practice-frame-footer-svg', frameUrl: frame.url(), side, target };
  } catch (clickError) {
    try {
      await frame.locator('svg').nth(target.index).evaluate(element => element.click());
      return { ok: true, method: 'practice-frame-svg-dom-click', frameUrl: frame.url(), side, target };
    } catch (domClickError) {
      return {
        ok: false,
        frameUrl: frame.url(),
        reason: `Could not click the ${side} footer arrow: ${clickError.message}; DOM fallback: ${domClickError.message}`,
        target,
        candidates,
      };
    }
  }
}
async function waitForQuestionChange(page, previousNumber, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = await findQuestionFrame(page);
    if (frame) {
      try {
        const text = await frame.locator('body').innerText({ timeout: 500 });
        const counter = questionCounter(text);
        if (counter && counter.current !== previousNumber) return;
      } catch {}
    }
    await page.waitForTimeout(250);
  }
  throw new Error('Không thấy bộ đếm câu hỏi đổi sau khi bấm nút chuyển trang.');
}
async function waitForPageChange(page, previousFingerprint, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = await findQuestionFrame(page);
    if (frame) {
      try {
        const text = await frame.locator('body').innerText({ timeout: 500 });
        if (text !== previousFingerprint) return;
      } catch {}
    }
    await page.waitForTimeout(250);
  }
  throw new Error('Page text did not change after navigation.');
}

async function returnToFirstQuestion(page, counter) {
  let current = counter;
  let steps = 0;
  while (current.current > 1 && steps < MAX_QUESTIONS) {
    const previousNumber = current.current;
    const result = await clickQuestionButton(page, 'previous');
    if (!result.ok) throw new Error(`Không tìm được nút quay lại câu 1: ${result.reason}`);
    await waitForQuestionChange(page, previousNumber);
    await page.waitForTimeout(250);
    const snapshot = await inspectQuestion(page);
    current = snapshot.counter ?? questionCounter(snapshot.bodyText);
    if (!current) throw new Error('Mất bộ đếm câu hỏi khi quay về đầu đề.');
    steps += 1;
  }
  if (current.current !== 1) throw new Error('Không quay được về câu 1 trong giới hạn 200 bước.');
  return current;
}

async function saveAsset(context, page, asset, assetDir, cache) {
  const url = asset.url;
  if (!url || url.startsWith('data:')) return { ...asset, localFile: null };
  const urlCacheKey = `url:${createHash('sha256').update(url).digest('hex')}`;
  if (cache.has(urlCacheKey)) return { ...asset, localFile: cache.get(urlCacheKey) };

  let bytes;
  let mimeType = '';
  try {
    if (url.startsWith('blob:')) {
      const blobData = await page.evaluate(async (blobUrl) => {
        const response = await fetch(blobUrl);
        const blob = await response.blob();
        if (blob.size > 30 * 1024 * 1024) throw new Error('Asset exceeds the 30 MB limit.');
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        return { data, mimeType: blob.type, size: blob.size };
      }, url);
      bytes = Buffer.from(blobData.data, 'base64');
      mimeType = blobData.mimeType;
    } else {
      const response = await context.request.get(url, { timeout: 20000 });
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      const contentLength = Number(response.headers()['content-length'] || 0);
      if (contentLength > MAX_ASSET_BYTES) throw new Error('Asset exceeds the 30 MB limit.');
      bytes = await response.body();
      mimeType = response.headers()['content-type'] || '';
      if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error('Asset exceeds the 30 MB limit.');
    }
  } catch (error) {
    return { ...asset, localFile: null, downloadError: error.message };
  }

  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const contentCacheKey = `content:${asset.kind}:${contentHash}`;
  if (cache.has(contentCacheKey)) {
    const localFile = cache.get(contentCacheKey);
    cache.set(urlCacheKey, localFile);
    return { ...asset, mimeType, localFile };
  }

  const fallback = asset.kind === 'image' ? '.img' : asset.kind === 'video' ? '.video' : '.audio';
  const extension = extensionFrom(url, mimeType, fallback);
  const filename = `${asset.kind}-${contentHash.slice(0, 12)}${extension}`;
  const destination = path.join(assetDir, filename);
  await writeFile(destination, bytes);
  const relative = path.relative(path.dirname(assetDir), destination).split(path.sep).join('/');
  cache.set(urlCacheKey, relative);
  cache.set(contentCacheKey, relative);
  return { ...asset, mimeType, localFile: relative };
}

function isAudioAsset(asset) {
  return asset.kind === 'audio' || /\.(?:mp3|m4a|ogg|wav)(?:[?#]|$)/i.test(asset.url || asset.localFile || '');
}

function mediaForQuestion(mediaAssets, questionNumber) {
  const otherMedia = mediaAssets.filter(asset => !isAudioAsset(asset));
  if (questionNumber >= 100) return otherMedia;
  const currentAudio = mediaAssets.find(isAudioAsset);
  return currentAudio ? [currentAudio, ...otherMedia] : otherMedia;
}

async function captureExam(page, context, url, examNumber, outputDir, resume = false) {
  console.log(`\nĐang mở đề ${examNumber}: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('Nếu trang yêu cầu đăng nhập, hãy đăng nhập trực tiếp trong cửa sổ Edge. Mật khẩu không được lưu vào file.');
  await rl.question(resume ? 'Khi Edge hiển thị đúng câu cần bắt đầu hoặc tiếp tục, nhấn Enter tại cửa sổ terminal... ' : 'Khi đã thấy câu hỏi đầu tiên của đề trong Edge, nhấn Enter tại cửa sổ terminal... ');

  if (new URL(page.url()).hostname !== TARGET_HOST) {
    throw new Error(`Trang hiện tại không còn ở ${TARGET_HOST}. Đã dừng để tránh đọc nhầm website.`);
  }

  const targetPath = new URL(url).pathname;
  if (new URL(page.url()).pathname !== targetPath) {
    console.log('Đang mở lại URL đề trong phiên vừa đăng nhập...');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  try {
    await waitForExamContent(page, 90000);
  } catch {
    console.log(`Chưa thấy nội dung câu hỏi. Trang hiện tại: ${page.url()}`);
    await rl.question('Trong Edge, hãy đăng nhập hoặc mở đúng đề, đợi nội dung hiện ra rồi nhấn Enter để thử lại... ');
    if (new URL(page.url()).pathname !== targetPath) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    try {
      await waitForExamContent(page, 90000);
    } catch {
      const examDir = path.join(outputDir, `exam-${String(examNumber).padStart(2, '0')}`);
      await mkdir(examDir, { recursive: true });
      const diagnosticPath = path.join(examDir, 'page-diagnostic.json');
      await writeFile(diagnosticPath, JSON.stringify({
        pageUrl: page.url(),
        title: await page.title(),
        frames: await describePageFrames(page),
      }, null, 2), 'utf8');
      throw new Error(`Không đọc được câu hỏi dù Edge đang hiển thị trang. Thông tin chẩn đoán đã lưu tại ${diagnosticPath}.`);
    }
  }

  const examDir = path.join(outputDir, `exam-${String(examNumber).padStart(2, '0')}`);
  const assetDir = path.join(examDir, 'assets');
  const jsonPath = path.join(examDir, 'questions.json');
  await mkdir(examDir, { recursive: true });
  let records = [];
  if (resume) {
    try {
      records = JSON.parse(await readFile(jsonPath, 'utf8'));
      if (!Array.isArray(records)) throw new Error('The saved questions file is not a JSON array.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot resume from ${jsonPath}: ${error.message}`);
    }
  }
  if (resume && records.length) {
    const hasLegacyPart5 = records.some(record => Number(record.question) >= 101 && Number(record.question) <= 130 && !record.promptText);
    const hasLegacyPart6 = records.some(record => Number(record.question) >= 131 && Number(record.question) <= 146 && !record.passageText);
    if (hasLegacyPart5 || hasLegacyPart6) {
      throw new Error(`Bản lưu ${jsonPath} chưa có dữ liệu chỗ trống Part 5/6. Hãy chạy không có --resume để tạo bộ dữ liệu mới; không thể khôi phục chính xác đáp án Part 6 từ chữ đã lưu.`);
    }
  }
  const savedQuestions = new Set(records.map(record => Number(record.question)).filter(Number.isInteger));
  const savedMax = savedQuestions.size ? Math.max(...savedQuestions) : 0;
  if (savedMax && (savedQuestions.size !== savedMax || records.length !== savedQuestions.size)) {
    throw new Error(`The saved questions in ${jsonPath} have gaps or duplicates; refusing to resume automatically.`);
  }

  let first = await inspectQuestion(page);
  const firstPageCounter = first.counter ?? questionCounter(first.bodyText);
  let counter = firstPageCounter ?? inferQuestionRange(first.bodyText);
  if (!counter) throw new Error('Không xác định được số câu trên trang. Hãy mở đúng màn hình đề rồi chạy lại.');
  const total = Math.min(counter.total, MAX_QUESTIONS);
  if (savedMax >= total) {
    console.log(`  Đề ${examNumber} đã có đủ ${total} câu trong bản lưu; bỏ qua.`);
    return records;
  }
  if (savedMax > 0 && counter.current > savedMax + 1) {
    throw new Error(`Bản lưu đã có đến câu ${savedMax}, nhưng Edge đang ở nhóm ${counter.current}-${counter.end}; như vậy sẽ thiếu câu ${savedMax + 1}-${counter.current - 1}. Hãy mở lại một nhóm trước đó rồi dùng --resume.`);
  }
  while (savedMax > 0 && firstPageCounter && counter.current <= savedMax) {
    console.log(`  Đang bỏ qua nhóm ${counter.current}-${counter.end} đã có trong bản lưu...`);
    const previousNumber = counter.current;
    const clickResult = await clickQuestionButton(page, 'next');
    if (!clickResult.ok) throw new Error(`Không thể chuyển tới câu ${savedMax + 1} khi tiếp tục: ${clickResult.reason}`);
    await waitForQuestionChange(page, previousNumber, 45000);
    await page.waitForTimeout(250);
    first = await inspectQuestion(page);
    counter = first.counter ?? questionCounter(first.bodyText) ?? inferQuestionRange(first.bodyText);
    if (!counter) throw new Error('Không đọc được bộ đếm sau khi bỏ qua câu đã lưu.');
  }
  if (savedMax > 0 && counter.current !== savedMax + 1) {
    throw new Error(`Bản lưu đã có đến câu ${savedMax}, nhưng Edge đang ở nhóm ${counter.current}-${counter.end}. Mở đúng nhóm câu tiếp theo rồi chạy lại với --resume.`);
  }
  if (savedMax === 0 && firstPageCounter && counter.current !== 1) {
    throw new Error(`Edge đang ở nhóm câu ${counter.current}-${counter.end} nhưng chưa có dữ liệu cũ để ghép. Hãy mở câu 1, hoặc dùng --resume với thư mục đã lưu trước đó.`);
  }
  if (!firstPageCounter) {
    console.log(`Trang này không có bộ đếm hiển thị. Script sẽ thử đọc nội dung câu ${counter.current}-${counter.end}; nếu không tìm được nút chuyển tiếp, phần chẩn đoán sẽ được lưu.`);
  } else if (savedMax > 0) {
    console.log(`Tiếp tục từ câu ${counter.current}; đã có sẵn câu 1-${savedMax}.`);
  }

  await mkdir(assetDir, { recursive: true });
  const assetCache = new Map();

  let pageIndex = 0;
  let assumedNextQuestion = counter.current;
  while (counter.current <= total && pageIndex < MAX_QUESTIONS) {
    const snapshot = pageIndex === 0 ? first : await inspectQuestion(page);
    const currentCounter = snapshot.counter ?? questionCounter(snapshot.bodyText);
    const inferredRange = inferQuestionRange(snapshot.bodyText);
    const range = currentCounter ?? (inferredRange
      ? { current: assumedNextQuestion, end: Math.max(assumedNextQuestion, inferredRange.end), total }
      : counter);
    const listeningScript = range.current <= 100 ? await captureListeningScript(page) : '';
    if (range.current <= 100 && !listeningScript) {
      console.log(`  Chưa đọc được nội dung bài nghe ở nhóm ${range.current}-${range.end}; sẽ giữ chỗ transcript để có thể bổ sung sau.`);
    }
    let questionBlocks = splitQuestionBlocks(snapshot.bodyText, range, snapshot.inlineAnswerElements || []);
    if (questionBlocks.length === 0) {
      questionBlocks = [{ number: range.current, pageText: snapshot.bodyText }];
    }
    const imageAssets = [];
    const mediaAssets = [];

    for (const asset of snapshot.images) {
      imageAssets.push(await saveAsset(context, page, { ...asset, kind: 'image' }, assetDir, assetCache));
    }
    const uniqueImageAssets = Array.from(new Map(imageAssets.map(asset => [asset.localFile || asset.url, asset])).values());
    for (const block of questionBlocks) {
      if (/Listen and choose the correct letter|Look at the graphic|Saludos Hispanos Magazine/i.test(block.pageText) && !uniqueImageAssets.some(asset => asset.localFile)) {
        console.log(`  Cảnh báo: câu ${block.number} cần hình nhưng chưa lưu được ảnh; kiểm tra hoặc trích xuất lại câu này.`);
      }
    }
    for (const asset of snapshot.media) {
      mediaAssets.push(await saveAsset(context, page, asset, assetDir, assetCache));
    }

    for (const block of questionBlocks) {
      records.push({
        exam: examNumber,
        question: block.number,
        questionGroup: block.questionGroup ?? null,
        pageUrl: snapshot.pageUrl,
        correctAnswer: block.correctAnswer ?? answerFromText(block.pageText),
        correctAnswerText: block.correctAnswerText ?? '',
        promptText: block.promptText ?? '',
        passageText: block.passageText ?? '',
        ...(block.number <= 100 ? { transcript: { en: listeningScript, vi: '' } } : {}),
        pageText: block.pageText,
        images: uniqueImageAssets,
        media: mediaForQuestion(mediaAssets, block.number),
      });
    }
    await writeFile(jsonPath, JSON.stringify(records, null, 2), 'utf8');
    console.log(`  Đã lưu câu ${questionBlocks.map(block => block.number).join(', ')} / ${total} (ảnh: ${uniqueImageAssets.length}, audio/video: ${mediaAssets.length})`);

    await page.evaluate(() => performance.clearResourceTimings());
    if (range.end >= total) break;
    const previousNumber = range.current;
    const clickResult = await clickQuestionButton(page, 'next');
    if (!clickResult.ok) {
      const diagnosticPath = path.join(examDir, 'navigation-diagnostic.json');
      await writeFile(diagnosticPath, JSON.stringify({
        pageUrl: snapshot.pageUrl,
        title: snapshot.title,
        inferredRange: range,
        controls: snapshot.controls,
        clickResult,
        bodyText: snapshot.bodyText.slice(0, 8000),
      }, null, 2), 'utf8');
      console.log(`  Đã lưu nội dung đến câu ${range.end}; không tìm được nút chuyển tiếp (${clickResult.reason}).`);
      console.log(`  Thông tin giao diện để chẩn đoán: ${diagnosticPath}`);
      break;
    }
    try {
      if (currentCounter) await waitForQuestionChange(page, previousNumber);
      else await waitForPageChange(page, pageFingerprint(snapshot));
      await page.waitForTimeout(350);
    } catch (automaticWaitError) {
      console.log(`  Mũi tên đã được bấm nhưng trang chưa chuyển (${automaticWaitError.message}).`);
      await rl.question('  Trong Edge, nếu vẫn ở cùng câu, bấm mũi tên phải một lần; khi câu mới hiện, nhấn Enter tại terminal... ');
      try {
        if (currentCounter) await waitForQuestionChange(page, previousNumber, 45000);
        else await waitForPageChange(page, pageFingerprint(snapshot), 45000);
        await page.waitForTimeout(350);
      } catch (manualWaitError) {
        const afterSnapshot = await inspectQuestion(page);
        const diagnosticPath = path.join(examDir, 'navigation-diagnostic.json');
        await writeFile(diagnosticPath, JSON.stringify({
          pageUrl: afterSnapshot.pageUrl,
          title: afterSnapshot.title,
          inferredRange: range,
          reason: 'Page content did not change after automatic and manual navigation attempts.',
          automaticWaitError: automaticWaitError.message,
          manualWaitError: manualWaitError.message,
          controls: afterSnapshot.controls,
          clickResult,
          bodyText: afterSnapshot.bodyText.slice(0, 8000),
        }, null, 2), 'utf8');
        console.log(`  Dừng sau nhóm ${range.current}-${range.end}: trang vẫn chưa chuyển sau thao tác trong Edge.`);
        console.log(`  Thông tin giao diện để chẩn đoán: ${diagnosticPath}`);
        break;
      }
    }
    const nextSnapshot = await inspectQuestion(page);
    const nextCounter = nextSnapshot.counter ?? questionCounter(nextSnapshot.bodyText);
    const nextInferredRange = inferQuestionRange(nextSnapshot.bodyText);
    assumedNextQuestion = range.end + 1;
    counter = nextCounter ?? (nextInferredRange
      ? { current: assumedNextQuestion, end: Math.max(assumedNextQuestion, nextInferredRange.end), total }
      : { current: assumedNextQuestion, end: assumedNextQuestion, total });
    pageIndex += 1;
  }

  return records;
}

async function captureExamTranscripts(page, url, examNumber, outputDir) {
  const examDir = path.join(outputDir, `exam-${String(examNumber).padStart(2, '0')}`);
  const jsonPath = path.join(examDir, 'questions.json');
  let records;
  try {
    records = JSON.parse(await readFile(jsonPath, 'utf8'));
  } catch (error) {
    throw new Error(`Không đọc được dữ liệu câu hỏi để bổ sung transcript: ${jsonPath} (${error.message})`);
  }
  if (!Array.isArray(records) || records.length === 0) throw new Error(`Không có câu hỏi trong ${jsonPath}.`);

  console.log(`\nĐang bổ sung transcript đề ${examNumber}: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await rl.question('Đăng nhập nếu cần, mở câu đầu tiên của đề trong Edge rồi nhấn Enter... ');
  if (new URL(page.url()).hostname !== TARGET_HOST) {
    throw new Error(`Trang hiện tại không còn ở ${TARGET_HOST}. Đã dừng để tránh đọc nhầm website.`);
  }
  if (new URL(page.url()).pathname !== new URL(url).pathname) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await waitForExamContent(page, 90000);

  let snapshot = await inspectQuestion(page);
  let counter = snapshot.counter ?? questionCounter(snapshot.bodyText) ?? inferQuestionRange(snapshot.bodyText);
  if (!counter) throw new Error(`Không xác định được câu hiện tại khi bổ sung transcript đề ${examNumber}.`);
  if (counter.current > 1) counter = await returnToFirstQuestion(page, counter);

  while (counter.current <= 100) {
    snapshot = await inspectQuestion(page);
    const range = snapshot.counter ?? questionCounter(snapshot.bodyText) ?? inferQuestionRange(snapshot.bodyText) ?? counter;
    if (range.current > 100) break;
    const script = await captureListeningScript(page);
    if (!script && range.current === 1) {
      const frames = await describePageFrames(page);
      console.log(`  Chẩn đoán script đề ${examNumber}: ${JSON.stringify(frames.map(frame => ({ url: frame.url, bodyText: frame.bodyText.slice(0, 900) })))}`);
    }
    const groupEnd = Math.min(range.end, 100);
    const matching = records.filter(record => Number(record.question) >= range.current && Number(record.question) <= groupEnd);
    if (script) {
      for (const record of matching) {
        const previous = record.transcript || {};
        record.transcript = { ...previous, en: script, vi: previous.vi || '' };
      }
      await writeFile(jsonPath, JSON.stringify(records, null, 2), 'utf8');
    }
    if (script) console.log(`  Đã lưu transcript tiếng Anh cho nhóm ${range.current}-${groupEnd}.`);
    else console.log(`  Chưa đọc được transcript nhóm ${range.current}-${groupEnd}; dữ liệu cũ được giữ nguyên.`);
    if (range.end >= 100) break;

    const clickResult = await clickQuestionButton(page, 'next');
    if (!clickResult.ok) throw new Error(`Không thể chuyển tới nhóm nghe tiếp theo: ${clickResult.reason}`);
    try {
      await waitForQuestionChange(page, range.current, 45000);
    } catch (firstNavigationError) {
      const afterFirstClick = await inspectQuestion(page);
      const afterFirstCounter = afterFirstClick.counter ?? questionCounter(afterFirstClick.bodyText) ?? inferQuestionRange(afterFirstClick.bodyText);
      if (afterFirstCounter?.current !== range.current && afterFirstClick.bodyText !== snapshot.bodyText) {
        console.log(`  Trang đã đổi nội dung sang nhóm ${afterFirstCounter?.current ?? 'mới'} dù bộ đếm không ổn định; tiếp tục.`);
      } else {
        const retryResult = await clickQuestionButton(page, 'next');
        if (!retryResult.ok) throw new Error(`Không thể chuyển tới nhóm nghe tiếp theo sau lần thử lại: ${retryResult.reason}`);
        try {
          await waitForQuestionChange(page, range.current, 45000);
        } catch (retryNavigationError) {
          throw new Error(`Không chuyển được khỏi nhóm ${range.current}-${range.end} sau hai lần bấm: ${firstNavigationError.message}; lần thử lại: ${retryNavigationError.message}`);
        }
      }
    }
    await page.waitForTimeout(200);
    snapshot = await inspectQuestion(page);
    counter = snapshot.counter ?? questionCounter(snapshot.bodyText) ?? inferQuestionRange(snapshot.bodyText);
    if (!counter) throw new Error('Không xác định được bộ đếm sau khi chuyển sang nhóm nghe tiếp theo.');
  }
  return records;
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('Chưa có Playwright. Cài bằng lệnh: npm.cmd install playwright');
    process.exitCode = 1;
    return;
  }

  console.log('Trình trích xuất nội dung đề LCMS i-School');
  console.log('Không nhập tên đăng nhập hoặc mật khẩu vào terminal hay file.');
  const urls = await loadExamUrls();

  if (!urls.length) return;
  const args = process.argv.slice(2);
  let resumeDir = null;
  let transcriptDir = null;
  if (args.length) {
    if (args.length !== 2 || !['--resume', '--transcripts'].includes(args[0])) {
      throw new Error('Cách dùng: node .\\extract-lcms-exams.mjs [--resume <thư-mục>] hoặc --transcripts <thư-mục>');
    }
    const targetDir = path.resolve(process.cwd(), args[1]);
    let details;
    try {
      details = await stat(targetDir);
    } catch {
      throw new Error(`Không tìm thấy thư mục kết quả: ${targetDir}`);
    }
    if (!details.isDirectory()) throw new Error(`Đường dẫn kết quả không phải thư mục: ${targetDir}`);
    if (args[0] === '--resume') {
      resumeDir = targetDir;
      console.log(`Tiếp tục và ghép dữ liệu vào thư mục: ${resumeDir}`);
    } else {
      transcriptDir = targetDir;
      console.log(`Chỉ bổ sung transcript Part 1-4 vào thư mục: ${transcriptDir}`);
    }
  }
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const outputDir = transcriptDir ?? resumeDir ?? path.join(process.cwd(), `lcms-flashcards-${stamp}`);
  await mkdir(outputDir, { recursive: true });

  const context = await chromium.launchPersistentContext(EDGE_PROFILE_DIR, {
    channel: 'msedge',
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = context.pages()[0] ?? await context.newPage();
  const allRecords = [];
  try {
    for (let index = 0; index < urls.length; index += 1) {
      const records = transcriptDir
        ? await captureExamTranscripts(page, urls[index], index + 1, outputDir)
        : await captureExam(page, context, urls[index], index + 1, outputDir, Boolean(resumeDir));
      allRecords.push(...records);
    }

    const rows = [
      ['Exam', 'Question', 'Correct answer', 'Correct answer text', 'Prompt', 'Passage', 'Transcript (EN)', 'Transcript (VI)', 'Page text', 'Image files', 'Audio/video files'],
      ...allRecords.map(record => [
        record.exam,
        record.question,
        record.correctAnswer,
        record.correctAnswerText,
        record.promptText,
        record.passageText,
        record.transcript?.en || '',
        record.transcript?.vi || '',
        record.pageText,
        record.images.map(asset => asset.localFile).filter(Boolean).join(' | '),
        record.media.map(asset => asset.localFile).filter(Boolean).join(' | '),
      ]),
    ];
    const csv = '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    await writeFile(path.join(outputDir, 'flashcards.csv'), csv, 'utf8');
    await writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify({
      sourceHost: TARGET_HOST,
      createdAt: new Date().toISOString(),
      questionCount: allRecords.length,
      note: 'Page text, locally captured media, and listening transcripts where available for personal study. English transcript is captured from the LCMS listening-content dialog; Vietnamese translation is stored in transcript.vi.',
    }, null, 2), 'utf8');
    console.log(`\nHoàn tất. ${allRecords.length} câu được lưu tại:\n${outputDir}`);
    console.log('Mở flashcards.csv để nhập vào công cụ flashcard; questions.json giữ dữ liệu chi tiết hơn.');
  } finally {
    await context.close();
  }
}

main().catch(error => {
  console.error(`\nLỗi: ${error.message}`);
  process.exitCode = 1;
}).finally(() => rl.close());
