#!/usr/bin/env node
/**
 * Очистка встроенных EPUB-книг каталога от служебного мусора Викитеки (WSExport).
 *
 * Что делает для каждой книги в assets/catalog/*.epub:
 *  1. Титульная страница = название + автор (аккуратная типографика),
 *     без логотипа Wikisource и строки «Экспортировано из Викитеки».
 *  2. Удаляет из начала спайна страницы-мусор: текстовые оглавления со ссылками
 *     на главы, списки редакций, служебные страницы (они же удаляются из
 *     manifest, nav.xhtml и toc.ncx). nav.xhtml как логическое оглавление
 *     для нативной панели «Оглавление» сохраняется.
 *  3. Чистит внутри контентных файлов: шапки headertemplate, поисковые формы,
 *     интервики/категории (<link rel="mw:PageProp/...">), ссылочные оглавления
 *     (ul из wiki-ссылок, абзацы «Главы: I · II · …»), разворачивает внешние
 *     ссылки на wikisource.org (текст остаётся, ссылка убирается).
 *  4. eugene-onegin (calibre-экспорт): добавляет титульную страницу, убирает
 *     артефакты печатных номеров страниц и внешние сноски на feb-web.ru.
 *  5. Удаляет встроенные шрифты FreeSerif (WSExport кладёт ~7 МБ ttf в каждую
 *     книгу) вместе с manifest-item и @font-face в main.css.
 *  6. P24: полностью удаляет страницу «Об этом электронном издании»
 *     (about.xhtml) и все следы Викитеки/Wikisource: метаданные OPF
 *     (dc:source, dc:identifier-ссылка, contributor «Wikisource», префикс
 *     «автор »), dtb:uid и docAuthor в NCX, комментарии в main.css,
 *     ambox-баннеры, «примечания редактора Викитеки», utm_source-имена
 *     картинок. После чистки распакованное дерево проверяется на 0 вхождений
 *     «викитек»/«wikisource»/«Об этом электронном издании» и т. п.
 *
 * Обложки не трогаются; dc:title/dc:creator сохраняются (без префикса «автор »).
 * Файлы глав не переименовываются. ВНИМАНИЕ: удаление страниц из начала
 * сдвигает индексы спайна — у существующих читателей позиция чтения (CFI)
 * может сброситься; для новых читателей это ок.
 *
 * Запуск: pnpm clean:catalog-books  (из packages/app-expo)
 * Зависимости: только node + системные бинари zip/unzip (macOS/linux).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bodyOf,
  cleanContentDoc,
  deepScrubWikisourceDir,
  escapeRe,
  extractEpub,
  findWikisourceTraces,
  junkMeasureText,
  packEpub,
  stripTags,
  titlePageHtml,
} from "./lib/epub-clean-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// NARRA_CATALOG_DIR — только для тестовых прогонов на копии каталога
const CATALOG_DIR = process.env.NARRA_CATALOG_DIR || path.resolve(__dirname, "../assets/catalog");

/** Название/автор для титульных страниц — синхронизировано с
 *  src/lib/catalog/bundled-book-definitions.ts */
const BOOKS = {
  "fathers-and-sons": { title: "Отцы и дети", author: "Иван Тургенев" },
  "anna-karenina": { title: "Анна Каренина", author: "Лев Толстой" },
  "war-and-peace": { title: "Война и мир", author: "Лев Толстой" },
  "crime-and-punishment": { title: "Преступление и наказание", author: "Фёдор Достоевский" },
  "government-inspector": { title: "Ревизор", author: "Николай Гоголь" },
  "dead-souls": { title: "Мёртвые души", author: "Николай Гоголь" },
  "hero-of-our-time": { title: "Герой нашего времени", author: "Михаил Лермонтов" },
  "captains-daughter": { title: "Капитанская дочка", author: "Александр Пушкин" },
  "eugene-onegin": { title: "Евгений Онегин", author: "Александр Пушкин" },
  "gentleman-from-san-francisco": {
    title: "Господин из Сан-Франциско",
    author: "Иван Бунин",
  },
  "dark-avenues": { title: "Тёмные аллеи", author: "Иван Бунин" },
  "golden-key": {
    title: "Золотой ключик, или Приключения Буратино",
    author: "Алексей Толстой",
  },
  "twelve-chairs": { title: "Двенадцать стульев", author: "Илья Ильф и Евгений Петров" },
  "three-sisters": { title: "Три сестры", author: "Антон Чехов" },
  seagull: { title: "Чайка", author: "Антон Чехов" },
  "cherry-orchard": { title: "Вишнёвый сад", author: "Антон Чехов" },
  thunderstorm: { title: "Гроза", author: "Александр Островский" },
  odyssey: { title: "Одиссея", author: "Гомер", subtitle: "перевод В. А. Жуковского" },
};

/** Страницы, которые надо удалить из начала независимо от эвристики:
 *  dead-souls c0 — иллюстрация издания 1842 г. + список критики «См. также»;
 *  captains-daughter c1 — заглушка редакции 1960 г. (оглавление + примечания),
 *  сам текст книги лежит в редакции 1978 г. (c2). */
const EXPLICIT_DROP = {
  // c0 — список редакций с библиографией, c1 — заглушка редакции 1960 г.
  // (оглавление + примечания); сам текст книги — редакция 1978 г. (c2).
  "captains-daughter": [/^c0_/, /^c1_.*1960/],
};

/** Страницы, которые нельзя удалять, а надо превратить в страницу посвящения:
 *  twelve-chairs c0 = поисковая форма + посвящение Катаеву + оглавление. */
const DEDICATION_REWRITE = {
  "twelve-chairs": /^c0_/,
};

// ------------------------------------------------------ обработка книги
// Общие утилиты (stripTags, cleanContentDoc, titlePageHtml и т. д.) вынесены
// в ./lib/epub-clean-lib.mjs и используются также fetch-ru-catalog.mjs.

function processWikisourceBook(bookId, workDir, report) {
  const meta = BOOKS[bookId];
  const opsDir = path.join(workDir, "OPS");
  const opfPath = path.join(opsDir, "content.opf");
  let opf = fs.readFileSync(opfPath, "utf8");

  const manifestItems = new Map();
  for (const m of opf.matchAll(/<item\b[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*\/>/g)) {
    manifestItems.set(m[1], m[2]);
  }
  const spineMatch = opf.match(/<spine[^>]*>([\s\S]*?)<\/spine>/);
  const spineIds = [...spineMatch[1].matchAll(/idref="([^"]+)"/g)].map((m) => m[1]);
  const uniqueSpine = [...new Set(spineIds)];
  report.spineBefore = uniqueSpine.slice();

  // 1. Титульная страница
  const titleHref = manifestItems.get("title");
  fs.writeFileSync(
    path.join(opsDir, titleHref),
    titlePageHtml(meta.title, meta.author, meta.subtitle),
    "utf8",
  );

  // 2. Мусорные страницы в начале спайна (после титула, до первого контента).
  //    Эвристика считает текст страницы ПОСЛЕ чистки от оглавлений/шапок:
  //    если содержимого почти не остаётся, страница была служебной.
  const explicitDrop = EXPLICIT_DROP[bookId] ?? [];
  const dedicationRe = DEDICATION_REWRITE[bookId];
  const removed = [];
  for (const id of uniqueSpine) {
    if (id === "title") continue;
    if (id === "about") break;
    const href = manifestItems.get(id);
    const file = path.join(opsDir, href);
    const src = fs.readFileSync(file, "utf8");
    if (dedicationRe?.test(id)) {
      // страница с посвящением: оставить только посвящение
      const block = src.match(/<div class="align-right"[^>]*>[\s\S]*?Посвящается[\s\S]*?<\/div>/);
      if (block) {
        const rewritten = src.replace(
          /(<body[^>]*>)[\s\S]*(<\/body>)/,
          `$1\n<div style="padding-top: 35%; text-align: center; text-indent: 0;">${block[0]
            .replace(/<div class="align-right"[^>]*>/, '<div style="font-style: italic;">')}</div>\n$2`,
        );
        fs.writeFileSync(file, rewritten, "utf8");
        report.dedicationPage = id;
        // подпись в оглавлении: «Посвящение» вместо названия книги
        const navPath = path.join(opsDir, "nav.xhtml");
        if (fs.existsSync(navPath)) {
          fs.writeFileSync(
            navPath,
            fs
              .readFileSync(navPath, "utf8")
              .replace(new RegExp(`(<a href="${escapeRe(href)}"[^>]*>)[^<]*`), "$1Посвящение"),
            "utf8",
          );
        }
        const ncxPath = path.join(opsDir, "toc.ncx");
        if (fs.existsSync(ncxPath)) {
          fs.writeFileSync(
            ncxPath,
            fs
              .readFileSync(ncxPath, "utf8")
              .replace(
                new RegExp(
                  `(<navPoint id="${escapeRe(id)}"[^>]*>\\s*<navLabel>\\s*<text>)[^<]*`,
                ),
                "$1Посвящение",
              ),
            "utf8",
          );
        }
      }
      break;
    }
    const origAnchors = (bodyOf(src).match(/<a\b[^>]*>/g) ?? []).length;
    const measured = junkMeasureText(src);
    const isJunk =
      explicitDrop.some((re) => re.test(id)) ||
      (origAnchors >= 3 && measured.length < 300) ||
      measured.length < 50;
    if (!isJunk) break;
    removed.push({ id, href, measuredLen: measured.length });
  }

  for (const { id, href } of removed) {
    fs.rmSync(path.join(opsDir, href), { force: true });
    // manifest + spine (учитываем возможные дубли itemref)
    opf = opf.replace(
      new RegExp(`<item\\b[^>]*id="${escapeRe(id)}"[^>]*/>\\s*`, "g"),
      "",
    );
    opf = opf.replace(
      new RegExp(`<itemref idref="${escapeRe(id)}"[^>]*/>\\s*`, "g"),
      "",
    );
    manifestItems.delete(id);
  }

  // 3. Чистка внутри оставшихся контентных файлов (кроме title/about/nav)
  for (const [id, href] of manifestItems) {
    if (!href.endsWith(".xhtml")) continue;
    if (id === "title" || id === "about" || id === "nav") continue;
    const file = path.join(opsDir, href);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    let cleaned = cleanContentDoc(src);
    // Страница-разделитель (например «Том I»), у которой после чистки не
    // осталось контента: показываем её заголовок из <title>.
    if (stripTags(bodyOf(cleaned)).length < 5) {
      const pageTitle = stripTags(cleaned.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
      if (pageTitle) {
        cleaned = cleaned.replace(
          /(<body[^>]*>)[\s\S]*?(<\/body>)/,
          `$1\n<div style="padding-top: 40%; text-align: center; text-indent: 0;"><h2 style="font-weight: 600;">${pageTitle}</h2></div>\n$2`,
        );
      }
    }
    if (cleaned !== src) fs.writeFileSync(file, cleaned, "utf8");
  }

  // 4. nav.xhtml + toc.ncx: убрать записи удалённых страниц
  const removedHrefs = removed.map((r) => r.href);
  const spineAfterIds = uniqueSpine.filter((id) => !removed.some((r) => r.id === id));
  const firstContentHref = manifestItems.get(spineAfterIds[1]);
  const navPath = path.join(opsDir, "nav.xhtml");
  if (fs.existsSync(navPath)) {
    let nav = fs.readFileSync(navPath, "utf8");
    for (const href of removedHrefs) {
      nav = nav.replace(
        new RegExp(`<li\\b[^>]*>\\s*<a [^>]*href="${escapeRe(href)}"[^>]*>[\\s\\S]*?</a>\\s*</li>`, "g"),
        "",
      );
      // остаточные ссылки (например landmark bodymatter) → первая контентная страница
      if (firstContentHref) {
        nav = nav.replaceAll(`href="${href}"`, `href="${firstContentHref}"`);
      }
    }
    fs.writeFileSync(navPath, nav, "utf8");
  }
  const ncxPath = path.join(opsDir, "toc.ncx");
  if (fs.existsSync(ncxPath)) {
    let ncx = fs.readFileSync(ncxPath, "utf8");
    for (const href of removedHrefs) {
      ncx = ncx.replace(
        new RegExp(`<navPoint\\b[^>]*>(?:(?!</navPoint>)[\\s\\S])*?src="${escapeRe(href)}"[\\s\\S]*?</navPoint>`, "g"),
        "",
      );
    }
    let order = 0;
    ncx = ncx.replace(/playOrder="\d+"/g, () => `playOrder="${++order}"`);
    fs.writeFileSync(ncxPath, ncx, "utf8");
  }

  // 5. Логотип Wikisource больше не используется — убрать файл и manifest-item
  const logoRel = "images/Wikisource-logo.svg.png";
  const logoAbs = path.join(opsDir, logoRel);
  if (fs.existsSync(logoAbs)) {
    let referenced = false;
    for (const [, href] of manifestItems) {
      if (!/\.(xhtml|css)$/.test(href)) continue;
      const file = path.join(opsDir, href);
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("Wikisource-logo")) {
        referenced = true;
        break;
      }
    }
    if (!referenced) {
      fs.rmSync(logoAbs, { force: true });
      opf = opf.replace(/<item\b[^>]*href="images\/Wikisource-logo\.svg\.png"[^>]*\/>\s*/g, "");
      const imagesDir = path.join(opsDir, "images");
      if (fs.existsSync(imagesDir) && fs.readdirSync(imagesDir).length === 0) {
        fs.rmdirSync(imagesDir);
      }
    }
  }

  // 6. Встроенные шрифты WSExport (FreeSerif, ~7 МБ) не нужны — читалка
  //    использует собственные шрифты. Убираем файлы, manifest-item и
  //    @font-face из main.css. Для книг без шрифтов шаг ничего не меняет.
  const fontHrefs = [...opf.matchAll(/<item\b[^>]*href="(fonts\/[^"]+)"[^>]*\/>/g)].map(
    (m) => m[1],
  );
  if (fontHrefs.length > 0) {
    for (const href of fontHrefs) {
      fs.rmSync(path.join(opsDir, href), { force: true });
      manifestItems.delete([...manifestItems].find(([, h]) => h === href)?.[0]);
    }
    opf = opf.replace(/<item\b[^>]*href="fonts\/[^"]+"[^>]*\/>\s*/g, "");
    const fontsDir = path.join(opsDir, "fonts");
    if (fs.existsSync(fontsDir) && fs.readdirSync(fontsDir).length === 0) {
      fs.rmdirSync(fontsDir);
    }
    const cssPath = path.join(opsDir, "main.css");
    if (fs.existsSync(cssPath)) {
      const css = fs
        .readFileSync(cssPath, "utf8")
        .replace(/@font-face\s*\{[^}]*url\("fonts\/[^}]*\}\s*/g, "")
        .replace(/body\s*\{\s*font-family:\s*"FreeSerif"\s*\}\s*/g, "");
      fs.writeFileSync(cssPath, css, "utf8");
    }
    report.notes = `удалены встроенные шрифты: ${fontHrefs.join(", ")}`;
  }

  fs.writeFileSync(opfPath, opf, "utf8");
  report.removed = removed;
  report.spineAfter = uniqueSpine.filter((id) => !removed.some((r) => r.id === id));
}

function processCalibreBook(bookId, workDir, report) {
  // eugene-onegin: calibre-экспорт без титула и без мусора Викитеки
  const meta = BOOKS[bookId];
  const opfPath = path.join(workDir, "content.opf");
  let opf = fs.readFileSync(opfPath, "utf8");
  const spineIds = [...opf.matchAll(/<itemref idref="([^"]+)"\s*\/>/g)].map((m) => m[1]);
  report.spineBefore = spineIds.slice();

  // титульная страница (повторный запуск не добавляет дубликат)
  fs.writeFileSync(
    path.join(workDir, "titlepage.xhtml"),
    titlePageHtml(meta.title, meta.author, meta.subtitle),
    "utf8",
  );
  if (!opf.includes('id="titlepage"')) {
    opf = opf.replace(
      /<manifest>/,
      `<manifest>\n    <item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>`,
    );
    opf = opf.replace(/(<spine[^>]*>)/, `$1\n    <itemref idref="titlepage"/>`);
    fs.writeFileSync(opfPath, opf, "utf8");
  }

  const cleanedNotes = [];
  for (const file of ["index_split_000.html", "index_split_001.html"]) {
    const p = path.join(workDir, file);
    let s = fs.readFileSync(p, "utf8");
    const before = s;
    // артефакты печатных номеров страниц: <p class="block_">42</p>
    s = s.replace(/\s*<p class="block_">\d+<\/p>/g, "");
    // дубль титула в начале текста (титульная страница теперь отдельная)
    s = s.replace(/\s*<p class="block_1">ЕВГЕНИЙ ОНЕГИН<\/p>/, "");
    s = s.replace(/\s*<p class="block_1">РОМАН В СТИХАХ<\/p>/, "");
    // внешние сноски на feb-web.ru: номера и «<См. перевод>» убрать, прочее развернуть
    s = s.replace(/<a\b[^>]*href="https?:\/\/feb-web\.ru[^"]*"[^>]*>([\s\S]*?)<\/a>/g, (full, inner) => {
      const text = stripTags(inner);
      if (/^\d+$/.test(text) || /См[\s.]*перевод/.test(text.replace(/&[lg]t;/g, ""))) return "";
      return inner;
    });
    if (s !== before) {
      fs.writeFileSync(p, s, "utf8");
      cleanedNotes.push(file);
    }
  }
  report.removed = [];
  report.spineAfter = spineIds.includes("titlepage") ? spineIds : ["titlepage", ...spineIds];
  report.notes = `добавлен titlepage.xhtml; вычищены печатные номера страниц и сноски feb-web в ${cleanedNotes.join(", ")}`;
}

// ----------------------------------------------------------- валидация

function validateBook(bookId, workDir, report) {
  const isCalibre = !fs.existsSync(path.join(workDir, "OPS"));
  const baseDir = isCalibre ? workDir : path.join(workDir, "OPS");
  const opf = fs.readFileSync(path.join(baseDir, "content.opf"), "utf8");
  const items = new Map(
    [...opf.matchAll(/<item\b[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*\/>/g)].map((m) => [m[1], m[2]]),
  );
  const spine = [
    ...new Set([...opf.match(/<spine[^>]*>[\s\S]*?<\/spine>/)[0].matchAll(/idref="([^"]+)"/g)].map((m) => m[1])),
  ];
  const firstHref = items.get(spine[0]);
  const firstText = stripTags(bodyOf(fs.readFileSync(path.join(baseDir, firstHref), "utf8")));
  const { title, author } = BOOKS[bookId];
  const errors = [];
  if (!firstText.includes(title) || !firstText.includes(author)) {
    errors.push(`титул не содержит название/автора: "${firstText.slice(0, 120)}"`);
  }
  // после титула допускается страница посвящения, затем сразу контент
  const secondText = stripTags(
    bodyOf(fs.readFileSync(path.join(baseDir, items.get(spine[1])), "utf8")),
  );
  report.secondPagePreview = secondText.slice(0, 200);
  const isDedication = /Посвящается/.test(secondText) && secondText.length < 400;
  if (isDedication) {
    const thirdText = stripTags(
      bodyOf(fs.readFileSync(path.join(baseDir, items.get(spine[2])), "utf8")),
    );
    report.thirdPagePreview = thirdText.slice(0, 200);
    if (thirdText.length < 200) {
      errors.push(`после посвящения нет контента (${thirdText.length} симв.)`);
    }
  } else if (secondText.length < 200) {
    errors.push(`вторая страница подозрительно короткая (${secondText.length} симв.): "${secondText.slice(0, 120)}"`);
  }
  report.errors = errors;
  return errors.length === 0;
}

// ---------------------------------------------------------------- main

function main() {
  const epubs = fs
    .readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith(".epub"))
    .sort();
  let failed = 0;
  for (const file of epubs) {
    const bookId = path.basename(file, ".epub");
    if (!BOOKS[bookId]) {
      console.warn(`! ${bookId}: нет в списке каталога, пропущен`);
      continue;
    }
    const epubPath = path.join(CATALOG_DIR, file);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `clean-epub-${bookId}-`));
    const report = {};
    try {
      extractEpub(epubPath, workDir);
      const isWikisource = fs.existsSync(path.join(workDir, "OPS"));
      if (isWikisource) {
        processWikisourceBook(bookId, workDir, report);
        // P24: полная зачистка следов Викитеки — страница «Об этом электронном
        // издании» (about.xhtml), wikisource-метаданные OPF/NCX, комментарии в
        // CSS, ambox-баннеры, utm_source-имена картинок. Общая логика с
        // clean-ru-catalog.mjs (внешний RU-каталог).
        deepScrubWikisourceDir(workDir, bookId, report, "urn:narra:");
        const traces = findWikisourceTraces(workDir);
        if (traces.length > 0) {
          report.errors = (report.errors ?? []).concat(
            traces.slice(0, 5).map((t) => `след Викитеки: ${t}`),
          );
        }
      } else {
        processCalibreBook(bookId, workDir, report);
      }
      const traceErrors = report.errors ?? [];
      const ok = validateBook(bookId, workDir, report) && traceErrors.length === 0;
      report.errors = traceErrors.concat(report.errors ?? []);
      if (ok) {
        packEpub(workDir, epubPath);
      } else {
        failed += 1;
      }
      const removedList = report.removed?.length
        ? report.removed.map((r) => r.id).join(", ")
        : "ничего";
      console.log(`${ok ? "✓" : "✗"} ${bookId}`);
      console.log(`    спайн: ${report.spineBefore.length} → ${report.spineAfter.length} страниц; удалено: ${removedList}`);
      if (report.notes) console.log(`    ${report.notes}`);
      console.log(`    стр. 2: ${report.secondPagePreview?.slice(0, 140) ?? "?"}`);
      for (const e of report.errors ?? []) console.log(`    ОШИБКА: ${e}`);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
  if (failed > 0) {
    console.error(`\nНе прошли валидацию: ${failed} книг(и) — EPUB не перезаписаны.`);
    process.exit(1);
  }
  console.log("\nГотово: все книги очищены и перезаписаны.");
}

main();
