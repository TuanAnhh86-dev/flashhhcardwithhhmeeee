#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(SCRIPT_DIR, 'lcms-flashcards-2026-10-21T07-39-10Z');
const TRANSLATIONS_FILE = path.join(SCRIPT_DIR, 'listening-translations-vi.json');

function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function optionTexts(english) {
  const options = new Map();
  const pattern = /^\s*(?:\(([A-D])\)|([A-D])[.)])\s*(.*?)\s*$/gm;
  for (const match of String(english || '').matchAll(pattern)) {
    const letter = (match[1] || match[2]).toUpperCase();
    const text = match[3].trim();
    if (text) options.set(letter, text);
  }
  return options;
}

async function main() {
  const translations = JSON.parse(await readFile(TRANSLATIONS_FILE, 'utf8'));
  const exams = [];

  for (let exam = 1; exam <= 2; exam += 1) {
    const examDir = path.join(DATA_DIR, `exam-${String(exam).padStart(2, '0')}`);
    const jsonPath = path.join(examDir, 'questions.json');
    const records = JSON.parse(await readFile(jsonPath, 'utf8'));
    const firstQuestionByScript = new Map();

    for (const record of records.filter(item => Number(item.question) <= 100)) {
      const english = String(record.transcript?.en || '').trim();
      if (english && !firstQuestionByScript.has(english)) {
        firstQuestionByScript.set(english, Number(record.question));
      }
    }

    const missing = Array.from(firstQuestionByScript.values())
      .filter(question => !String(translations[`${exam}-${question}`] || '').trim());
    const translationKeys = Object.keys(translations).filter(key => key.startsWith(`${exam}-`));
    if (firstQuestionByScript.size !== 54 || missing.length || translationKeys.length !== firstQuestionByScript.size) {
      throw new Error(`Exam ${exam}: expected 54 translated scripts; found ${firstQuestionByScript.size}, missing ${missing.join(', ') || 'none'}, map entries ${translationKeys.length}.`);
    }

    for (const record of records.filter(item => Number(item.question) <= 100)) {
      const english = String(record.transcript?.en || '').trim();
      const firstQuestion = firstQuestionByScript.get(english);
      if (!firstQuestion) throw new Error(`Exam ${exam}, question ${record.question}: no English transcript found.`);
      record.transcript.vi = translations[`${exam}-${firstQuestion}`];

      if (Number(record.question) <= 31) {
        const key = String(record.correctAnswer || '').trim().toUpperCase();
        const phrase = optionTexts(english).get(key);
        if (!phrase) {
          throw new Error(`Exam ${exam}, question ${record.question}: could not find option ${key} in the English transcript.`);
        }
        record.correctAnswerText = phrase;
      }
    }

    exams.push({ exam, jsonPath, records, firstQuestionByScript });
  }

  for (const exam of exams) {
    await writeFile(exam.jsonPath, JSON.stringify(exam.records, null, 2), 'utf8');
  }

  const records = exams.flatMap(exam => exam.records);
  const rows = [
    ['Exam', 'Question', 'Correct answer', 'Correct answer text', 'Prompt', 'Passage', 'Transcript (EN)', 'Transcript (VI)', 'Page text', 'Image files', 'Audio/video files'],
    ...records.map(record => [
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
  await writeFile(path.join(DATA_DIR, 'flashcards.csv'), csv, 'utf8');

  console.log(`Applied Vietnamese translations to ${exams.map(exam => `${exam.firstQuestionByScript.size} scripts in exam ${exam.exam}`).join(' and ')}; updated flashcards.csv.`);
}

main().catch(error => {
  console.error(`\nTranslation update failed: ${error.message}`);
  process.exitCode = 1;
});
