/**
 * epub-clean-lib.mjs — общие функции очистки EPUB-экспортов Викитеки (WSExport)
 * от служебного мусора. Используется clean-catalog-books.mjs (18 встроенных
 * книг) и fetch-ru-catalog.mjs (русский каталог P23).
 *
 * Здесь только generic-логика без знаний о конкретных книгах.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------- zip I/O

export function extractEpub(epubPath, destDir) {
  execFileSync("unzip", ["-oq", epubPath, "-d", destDir]);
}

export function packEpub(workDir, epubPath) {
  const tmpOut = `${epubPath}.tmp.zip`;
  fs.rmSync(tmpOut, { force: true });
  // mimetype обязан идти первым и без сжатия
  execFileSync("zip", ["-X", "-0", "-q", tmpOut, "mimetype"], { cwd: workDir });
  execFileSync("zip", ["-X", "-9", "-r", "-q", tmpOut, ".", "-x", "mimetype"], {
    cwd: workDir,
  });
  fs.renameSync(tmpOut, epubPath);
}

// ---------------------------------------------------------------- text utils

export function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function bodyOf(html) {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/);
  return m ? m[1] : html;
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ------------------------------------------------- чистка контента Викитеки

/** Служебные обвязки Викитеки, не являющиеся содержимым. */
export function removeChrome(html) {
  return (
    html
      // шапка headertemplate (+ хвостовой пустой span)
      .replace(
        /<div id="headertemplate[^"]*"[^>]*>\s*<div id="sub_nav[^"]*"\s*\/>\s*<br[^>]*\/>\s*<\/div>(\s*<span class="mw-empty-elt"[^>]*\/>)?/g,
        "",
      )
      // блок «Поиск по произведению» с формой
      .replace(
        /<div style="text-align:center; ">(?:(?!<\/form>)[\s\S])*?<form[\s\S]*?<\/form>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/g,
        "",
      )
      .replace(/<form name="searchbox"[\s\S]*?<\/form>/g, "")
      // интервики и категории
      .replace(/<link rel="mw:PageProp\/[^"]*"[^>]*\/>\s*/g, "")
  );
}

/** ul/dl, состоящие только из wiki-ссылок (текстовое оглавление). */
export function removeLinkOnlyLists(html) {
  return html.replace(/<(ul|dl)>[\s\S]*?<\/\1>/g, (list) => {
    if (!/rel="mw:WikiLink"/.test(list)) return list;
    const noAnchors = list.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, "");
    const residue = stripTags(noAnchors).replace(/[\s·—–\-,.:;()\[\]0-9IVXLC]+/g, "");
    return residue.length <= 5 ? "" : list;
  });
}

/** Абзацы вида «Главы: I · II · III …» (набор ссылок с разделителями). */
export function removeChapterLinkParagraphs(html) {
  return html.replace(/<p>[\s\S]*?<\/p>/g, (p) => {
    const anchors = p.match(/<a\b[^>]*rel="mw:WikiLink"[^>]*>/g) ?? [];
    if (anchors.length < 3) return p;
    const residue = stripTags(p.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, "")).replace(
      /^(Главы|Части|Действия|Явления|Том[аы]?)\s*[:.]?/u,
      "",
    );
    return residue.replace(/[\s·—–\-,.:;0-9IVXLC]+/g, "").length <= 5 ? "" : p;
  });
}

/** Внешние ссылки на wikisource → оставить только текст. */
export function unwrapWikisourceLinks(html) {
  return html.replace(
    /<a\b[^>]*href="https?:\/\/[a-z.]*wikisource\.org[^"]*"[^>]*>([\s\S]*?)<\/a>/g,
    "$1",
  );
}

/** Заголовок «Оглавление», оставшийся без списка после чистки. */
export function removeTocHeadings(html) {
  return html.replace(/<h([1-4])[^>]*>(?:(?!<\/h\1>)[\s\S])*?<\/h\1>/g, (h) =>
    /^(Оглавление|Содержание)$/.test(stripTags(h)) ? "" : h,
  );
}

export function cleanContentDoc(html) {
  let out = removeChrome(html);
  out = removeLinkOnlyLists(out);
  out = removeChapterLinkParagraphs(out);
  out = unwrapWikisourceLinks(out);
  out = removeTocHeadings(out);
  return out;
}

/** Статистика страницы: длина текста без ссылок и количество ссылок. */
export function pageStats(html) {
  let body = bodyOf(html);
  body = removeChrome(body);
  const anchors = body.match(/<a\b[^>]*>[\s\S]*?<\/a>/g) ?? [];
  const linkText = anchors.map((a) => stripTags(a)).join(" ");
  const totalText = stripTags(body);
  return {
    anchorCount: anchors.length,
    totalLen: totalText.length,
    nonLinkLen: Math.max(0, totalText.length - linkText.length),
  };
}

/** Текст страницы для оценки «служебная или контентная»: дополнительно к
 *  обычной чистке игнорируем разделы «См. также» и примечания о публикации —
 *  они не делают страницу-оглавление содержательной. */
export function junkMeasureText(html) {
  let x = cleanContentDoc(html);
  x = x.replace(
    /<section[^>]*>\s*<h(\d)[^>]*>(?:(?!<\/h\1>)[\s\S])*?См\.\s*также[\s\S]*?<\/section>/g,
    "",
  );
  x = x.replace(/<ol class="mw-references[\s\S]*?<\/ol>/g, "");
  x = x.replace(/<h([1-4])[^>]*>(?:(?!<\/h\1>)[\s\S])*?<\/h\1>/g, (h) =>
    /^Примечания\b/.test(stripTags(h)) ? "" : h,
  );
  return stripTags(bodyOf(x));
}

// ------------------------------------------------------------ титульный лист

export function titlePageHtml(title, author, subtitle, cssHref) {
  const css = cssHref ? `\n    <link type="text/css" rel="stylesheet" href="${cssHref}" />` : "";
  const subtitleLine = subtitle
    ? `\n      <p style="font-size: 0.85em; margin: 0.9em 0 0 0; opacity: 0.55;">${subtitle}</p>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ru" dir="ltr">
  <head>
    <title>${title}</title>${css}
  </head>
  <body style="margin: 0; padding: 0; text-align: center; text-indent: 0;">
    <div style="padding: 38% 8% 0 8%;">
      <h1 style="font-size: 1.9em; font-weight: 600; line-height: 1.25; margin: 0 0 0.75em 0; letter-spacing: 0.01em;">${title}</h1>
      <p style="font-size: 1.05em; margin: 0; opacity: 0.75;">${author}</p>${subtitleLine}
    </div>
  </body>
</html>
`;
}

// ------------------------------------------- generic-чистка WSExport-книги
//
// Обобщённый вариант шагов из clean-catalog-books.mjs без знаний о конкретной
// книге: титульный лист, мусорные страницы в начале спайна, чистка контента,
// nav/ncx, логотип Викитеки, встроенные шрифты FreeSerif.
// workDir — распакованный EPUB (структура WSExport: OPS/content.opf).
// meta: { title, author, subtitle? }
// Возвращает report { removed, spineBefore, spineAfter, notes }.

export function cleanWikisourceEpubDir(workDir, meta, report = {}) {
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
  if (titleHref) {
    fs.writeFileSync(
      path.join(opsDir, titleHref),
      titlePageHtml(meta.title, meta.author, meta.subtitle),
      "utf8",
    );
  }

  // 2. Мусорные страницы в начале спайна (после титула, до первого контента)
  const removed = [];
  for (const id of uniqueSpine) {
    if (id === "title") continue;
    if (id === "about") break;
    const href = manifestItems.get(id);
    if (!href) continue;
    const file = path.join(opsDir, href);
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    const origAnchors = (bodyOf(src).match(/<a\b[^>]*>/g) ?? []).length;
    const measured = junkMeasureText(src);
    const isJunk = (origAnchors >= 3 && measured.length < 300) || measured.length < 50;
    if (!isJunk) break;
    removed.push({ id, href, measuredLen: measured.length });
  }

  for (const { id, href } of removed) {
    fs.rmSync(path.join(opsDir, href), { force: true });
    opf = opf.replace(new RegExp(`<item\\b[^>]*id="${escapeRe(id)}"[^>]*/>\\s*`, "g"), "");
    opf = opf.replace(new RegExp(`<itemref idref="${escapeRe(id)}"[^>]*/>\\s*`, "g"), "");
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
    // Страница-разделитель («Том I»), оставшаяся пустой: заголовок из <title>
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

  // 5. Логотип Wikisource, если больше нигде не используется
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

  // 6. Встроенные шрифты WSExport (FreeSerif, ~7 МБ)
  const fontHrefs = [...opf.matchAll(/<item\b[^>]*href="(fonts\/[^"]+)"[^>]*\/>/g)].map((m) => m[1]);
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
  report.spineAfter = spineAfterIds;
  return report;
}

// ------------------------------------------- P24: полная чистка следов Викитеки
//
// Дополняет cleanWikisourceEpubDir (он оставляет about.xhtml и метаданные OPF):
// удаляет страницу «Об этом электронном издании», wikisource-метаданные OPF/NCX,
// комментарии в CSS, ambox-баннеры, «примечания редактора Викитеки»,
// utm_source-суффиксы в именах картинок. Используется clean-ru-catalog.mjs
// (внешний каталог) и clean-catalog-books.mjs (18 встроенных книг).

/** Страница «Об этом электронном издании»: спайн, манифест, nav, ncx, файл. */
export function removeAboutPage(opsDir, report = {}) {
  const opfPath = path.join(opsDir, "content.opf");
  let opf = fs.readFileSync(opfPath, "utf8");
  const aboutItem = opf.match(/<item\b[^>]*id="about"[^>]*href="([^"]+)"[^>]*\/>/);
  if (!aboutItem) return report;
  const href = aboutItem[1];
  opf = opf.replace(/<item\b[^>]*id="about"[^>]*\/>\s*/g, "");
  opf = opf.replace(/<itemref idref="about"[^>]*\/>\s*/g, "");
  fs.writeFileSync(opfPath, opf, "utf8");
  fs.rmSync(path.join(opsDir, href), { force: true });

  const navPath = path.join(opsDir, "nav.xhtml");
  if (fs.existsSync(navPath)) {
    let nav = fs.readFileSync(navPath, "utf8");
    nav = nav.replace(
      new RegExp(`<li\\b[^>]*>\\s*<a [^>]*href="${escapeRe(href)}"[^>]*>[\\s\\S]*?</a>\\s*</li>`, "g"),
      "",
    );
    fs.writeFileSync(navPath, nav, "utf8");
  }
  const ncxPath = path.join(opsDir, "toc.ncx");
  if (fs.existsSync(ncxPath)) {
    let ncx = fs.readFileSync(ncxPath, "utf8");
    ncx = ncx.replace(
      new RegExp(`<navPoint\\b[^>]*>(?:(?!</navPoint>)[\\s\\S])*?src="${escapeRe(href)}"[\\s\\S]*?</navPoint>\\s*`, "g"),
      "",
    );
    let order = 0;
    ncx = ncx.replace(/playOrder="\d+"/g, () => `playOrder="${++order}"`);
    fs.writeFileSync(ncxPath, ncx, "utf8");
  }
  report.aboutRemoved = href;
  return report;
}

/** OPF: identifier → urn, dc:source/contributor Wikisource — прочь, «автор » из
 *  dc:creator; NCX: dtb:uid → urn, docAuthor без префикса. */
export function scrubOpfWikisourceMetadata(opsDir, slug, urnPrefix = "urn:narra:ru:") {
  const opfPath = path.join(opsDir, "content.opf");
  let opf = fs.readFileSync(opfPath, "utf8");
  const before = opf;
  const urn = `${urnPrefix}${slug}`;
  opf = opf.replace(/(<dc:identifier id="uid">)[^<]*(<\/dc:identifier>)/, `$1${urn}$2`);
  opf = opf.replace(/<dc:source>[^<]*<\/dc:source>\s*/g, "");
  opf = opf.replace(/<dc:contributor id="meta-bkp">[^<]*<\/dc:contributor>\s*/g, "");
  opf = opf.replace(/<meta refines="#meta-bkp"[^>]*>[^<]*<\/meta>\s*/g, "");
  opf = opf.replace(/(<dc:creator[^>]*>)\s*[Аа]втор:?\s+/g, "$1");
  if (opf !== before) fs.writeFileSync(opfPath, opf, "utf8");

  const ncxPath = path.join(opsDir, "toc.ncx");
  if (fs.existsSync(ncxPath)) {
    let ncx = fs.readFileSync(ncxPath, "utf8");
    const nb = ncx;
    ncx = ncx.replace(/(<meta name="dtb:uid" content=")[^"]*(")/, `$1${urn}$2`);
    ncx = ncx.replace(/(<docAuthor><text>)\s*[Аа]втор:?\s+/g, "$1");
    if (ncx !== nb) fs.writeFileSync(ncxPath, ncx, "utf8");
  }
  return urn;
}

/** CSS: комментарии, упоминающие Wikisource/WS Export. */
export function scrubCssWikisourceComments(opsDir) {
  const cssPath = path.join(opsDir, "main.css");
  if (!fs.existsSync(cssPath)) return;
  const css = fs.readFileSync(cssPath, "utf8");
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, (c) =>
    /wikisource|викитек|wsexport/i.test(c) ? "" : c,
  );
  if (cleaned !== css) fs.writeFileSync(cssPath, cleaned, "utf8");
}

/** Контентный xhtml: ambox-баннеры, «примечания редактора Викитеки»,
 *  wikisource-ссылки, utm-хвосты, «викитечные» пункты списков.
 *  ВАЖНО: переименования картинок применять до вызова. */
export function scrubContentWikisource(src) {
  let s = src;
  s = s.replace(/<table class="[^"]*\bambox\b[^"]*"[\s\S]*?<\/table>/g, "");
  s = s.replace(/([Пп]римечани([ея]|ями?|ях))\s+редактор(ов|а)\s+Викитеки/g, "$1 редактор$3");
  s = s.replace(/прим\.\s*редактора\s+Викитеки/g, "прим. редактора");
  s = s.replace(/<a\b[^>]*href="[^"]*wikisource\.org[^"]*"[^>]*>([\s\S]*?)<\/a>/g, "$1");
  s = s.replace(/\?utm_source=ru\.wikisource\.org[^"']*/g, "");
  s = s.replace(/<link\b[^>]*wikisource[^>]*\/>\s*/gi, "");
  s = s.replace(/<li[^>]*>(?:(?!<\/li>)[\s\S])*?<\/li>/g, (li) => {
    const text = li.replace(/<[^>]+>/g, " ");
    return /Викитек|wikisource/i.test(text) ? "" : li;
  });
  return s;
}

/** Картинки с «_utm_source_ru.wikisource.org…» в имени: отрезать суффикс. */
export function renameUtmImages(opsDir) {
  const imagesDir = path.join(opsDir, "images");
  if (!fs.existsSync(imagesDir)) return new Map();
  const renames = new Map();
  for (const name of fs.readdirSync(imagesDir)) {
    const cut = name.indexOf("_utm_source_");
    if (cut === -1) continue;
    const base = name.slice(0, cut);
    let candidate = base;
    let n = 2;
    while (
      fs.existsSync(path.join(imagesDir, candidate)) ||
      [...renames.values()].includes(candidate)
    ) {
      const ext = path.extname(base);
      candidate = `${base.slice(0, base.length - ext.length)}_${n}${ext}`;
      n += 1;
    }
    fs.renameSync(path.join(imagesDir, name), path.join(imagesDir, candidate));
    renames.set(name, candidate);
  }
  return renames;
}

/** Картинки, на которые после чистки никто не ссылается — удалить. */
export function dropOrphanImages(opsDir) {
  const imagesDir = path.join(opsDir, "images");
  if (!fs.existsSync(imagesDir)) return 0;
  const refs = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(xhtml|html|css)$/.test(e.name)) refs.push(fs.readFileSync(p, "utf8"));
    }
  };
  walk(opsDir);
  const blob = refs.join("\n");
  const opfPath = path.join(opsDir, "content.opf");
  let opf = fs.readFileSync(opfPath, "utf8");
  let dropped = 0;
  for (const name of fs.readdirSync(imagesDir)) {
    if (blob.includes(`images/${name}`)) continue;
    const item = opf.match(new RegExp(`<item\\b[^>]*href="images/${escapeRe(name)}"[^>]*/>`));
    if (item && /properties="[^"]*cover-image/.test(item[0])) continue;
    const id = item?.[0].match(/id="([^"]+)"/)?.[1];
    if (id && new RegExp(`(idref|content)="${escapeRe(id)}"`).test(opf)) continue;
    fs.rmSync(path.join(imagesDir, name), { force: true });
    opf = opf.replace(new RegExp(`<item\\b[^>]*href="images/${escapeRe(name)}"[^>]*/>\\s*`, "g"), "");
    dropped += 1;
  }
  if (dropped) {
    fs.writeFileSync(opfPath, opf, "utf8");
    if (fs.readdirSync(imagesDir).length === 0) fs.rmdirSync(imagesDir);
  }
  return dropped;
}

/** Полная P24-чистка распакованного WSExport-EPUB (структура OPS/). */
export function deepScrubWikisourceDir(workDir, slug, report = {}, urnPrefix = "urn:narra:ru:") {
  const opsDir = path.join(workDir, "OPS");
  removeAboutPage(opsDir, report);
  report.identifier = scrubOpfWikisourceMetadata(opsDir, slug, urnPrefix);
  scrubCssWikisourceComments(opsDir);
  const renames = renameUtmImages(opsDir);
  if (renames.size) report.imageRenames = renames.size;
  for (const e of fs.readdirSync(opsDir)) {
    if (!e.endsWith(".xhtml") || e === "title.xhtml" || e === "nav.xhtml") continue;
    const p = path.join(opsDir, e);
    const src = fs.readFileSync(p, "utf8");
    let out = src;
    // «голое» имя файла покрывает href/src, id манифеста и data-атрибуты
    for (const [oldName, newName] of renames) out = out.split(oldName).join(newName);
    out = scrubContentWikisource(out);
    if (out !== src) fs.writeFileSync(p, out, "utf8");
  }
  if (renames.size) {
    const opfPath = path.join(opsDir, "content.opf");
    let opf = fs.readFileSync(opfPath, "utf8");
    for (const [oldName, newName] of renames) opf = opf.split(oldName).join(newName);
    fs.writeFileSync(opfPath, opf, "utf8");
  }
  const orphans = dropOrphanImages(opsDir);
  if (orphans) report.orphanImagesDropped = orphans;
  return report;
}

const WIKISOURCE_TRACE_PATTERNS = [
  "викитек",
  "wikisource",
  "народном достоянии",
  "об этом электронном издании",
  "экспортировано",
];

/** Честная проверка распакованного дерева: 0 следов Викитеки. */
export function findWikisourceTraces(workDir) {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(xhtml|html|opf|ncx|css|xml|txt|svg)$/i.test(e.name) || e.name === "mimetype") {
        const lower = fs.readFileSync(p, "utf8").toLowerCase();
        for (const pat of WIKISOURCE_TRACE_PATTERNS) {
          if (lower.includes(pat)) hits.push(`${path.relative(workDir, p)}: ${pat}`);
        }
      }
      if (/wikisource|викитек/i.test(e.name)) hits.push(`имя файла: ${e.name}`);
    }
  };
  walk(workDir);
  return hits;
}
