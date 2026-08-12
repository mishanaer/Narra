#!/usr/bin/env node
/**
 * clean-en-catalog.mjs — P22 phase 2: scrub Project Gutenberg boilerplate from
 * the English preload catalog (same catalog rules as the RU Wikisource
 * cleanup in packages/app-expo/scripts/clean-catalog-books.mjs: title page
 * "Title / Author" -> straight into the text).
 *
 * For every book listed in manifest.json inside the catalog dir:
 *  1. Removes PG boilerplate: the pg-header element (everything up to and
 *     including "*** START OF THE PROJECT GUTENBERG EBOOK ... ***"), the
 *     pg-footer element ("*** END OF ... ***" plus the full license), the
 *     generated branded cover page (wrap0000 + cover image), ebookmaker
 *     "generator" metas, "| Project Gutenberg" page titles, and PG references
 *     in OPF metadata (dc:source, gutenberg identifier). Legally required for
 *     commercial use without the PG trademark.
 *  2. Inserts a clean title page (Title / Author) as the first spine item.
 *  3. Link-sheet tables of contents at the start of the text are removed
 *     (inline pginternal link blocks) or made linear="no" (separate spine
 *     pages) while NCX/nav stays intact for the reader's TOC panel.
 *  4. Validates the result (title page first, then content; no PG phrases
 *     left; spine/OPF intact) and repacks. Idempotent: a second run is a
 *     no-op. Books that fail validation keep their original bytes and get
 *     cleaned:false in the manifest.
 *
 * Dependencies: node + system zip/unzip (same as the RU cleaner).
 * Usage: node scripts/clean-en-catalog.mjs [--dir <catalog-dir>] [--limit N] [--only slug]
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const CATALOG_DIR = argOf('--dir') || '/Users/aleksandr/Documents/ReadAny-catalog-en';
const LIMIT = +(argOf('--limit') || 0);
const ONLY = argOf('--only');

const START_RE = /\*\*\*\s*START OF TH(?:E|IS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i;
const END_RE = /\*\*\*\s*END OF TH(?:E|IS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i;
const PG_PHRASE_RE = /project\s+gutenberg/i;

// ---------------------------------------------------------------- helpers

function extractEpub(epubPath, destDir) {
  execFileSync('unzip', ['-oq', epubPath, '-d', destDir]);
}

function packEpub(workDir, epubPath) {
  const tmpOut = `${epubPath}.tmp.zip`;
  fs.rmSync(tmpOut, { force: true });
  execFileSync('zip', ['-X', '-0', '-q', tmpOut, 'mimetype'], { cwd: workDir });
  execFileSync('zip', ['-X', '-9', '-r', '-q', tmpOut, '.', '-x', 'mimetype'], { cwd: workDir });
  fs.renameSync(tmpOut, epubPath);
}

function stripTags(html) {
  return String(html)
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function bodyOf(html) {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : html;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Remove the balanced element (div|section) whose opening tag contains
 * `needle` (e.g. id="pg-header"). Handles nested and self-closing tags.
 * Returns null when not found.
 */
function removeBalancedElement(html, needle) {
  const openIdx = html.search(new RegExp(`<(div|section)\\b[^>]*${needle}[^>]*>`, 'i'));
  if (openIdx < 0) return null;
  const tag = html.slice(openIdx).match(/^<(div|section)/i)[1].toLowerCase();
  const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'gi');
  re.lastIndex = openIdx;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    const t = m[0];
    if (t[1] === '/') {
      depth--;
      if (depth === 0) return html.slice(0, openIdx) + html.slice(m.index + t.length);
    } else if (!/\/>$/.test(t)) {
      depth++;
    }
  }
  return null; // unbalanced — caller falls back to marker cut
}

/** Fallback: cut by raw *** markers when no pg-header/footer element exists. */
function cutByMarkers(html) {
  let out = html;
  let touched = false;
  const start = out.match(START_RE);
  if (start) {
    const bodyOpen = out.search(/<body[^>]*>/i);
    const bodyOpenEnd = bodyOpen >= 0 ? bodyOpen + out.slice(bodyOpen).match(/<body[^>]*>/i)[0].length : 0;
    const markerEnd = out.indexOf(start[0]) + start[0].length;
    // drop up to the end of the marker's enclosing line/element
    const closeAfter = out.slice(markerEnd).search(/<\/(p|div|h[1-6]|span|section)>/i);
    const cutAt = closeAfter >= 0
      ? markerEnd + closeAfter + out.slice(markerEnd + closeAfter).match(/<\/[a-z0-9]+>/i)[0].length
      : markerEnd;
    out = out.slice(0, bodyOpenEnd) + '\n' + out.slice(cutAt);
    touched = true;
  }
  const end = out.match(END_RE);
  if (end) {
    const endIdx = out.indexOf(end[0]);
    // back off to the start of the enclosing block if it is right before
    const before = out.slice(0, endIdx);
    const blockStart = Math.max(before.lastIndexOf('<div'), before.lastIndexOf('<section'), before.lastIndexOf('<p'));
    const cutFrom = blockStart > 0 && endIdx - blockStart < 400 ? blockStart : endIdx;
    const bodyClose = out.search(/<\/body>/i);
    out = out.slice(0, cutFrom) + '\n' + (bodyClose >= 0 ? out.slice(bodyClose) : '</body></html>');
    touched = true;
  }
  return touched ? out : null;
}

/** Inline link-sheet TOC blocks (p.toc / div.blk of pginternal links). */
function removeInlineTocBlocks(html) {
  let out = html;
  // <div class="blk"> wrapping only toc paragraphs
  out = out.replace(/<div class="blk">[\s\S]*?<\/div>/g, (block) => {
    const anchors = block.match(/<a\b[^>]*class="pginternal"[^>]*>/g) ?? [];
    if (anchors.length < 3) return block;
    const residue = stripTags(block.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, ''))
      .replace(/^(contents|table of contents|illustrations|list of illustrations)[\s.:]*/i, '')
      .replace(/[\s·.,:;()\[\]0-9IVXLCM—–-]+/gi, '');
    return residue.length <= 8 ? '' : block;
  });
  // standalone <p class="toc">…</p>
  out = out.replace(/<p class="toc">[\s\S]*?<\/p>/g, (p) => {
    const anchors = p.match(/<a\b[^>]*class="pginternal"[^>]*>/g) ?? [];
    if (anchors.length < 3) return p;
    const residue = stripTags(p.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, ''))
      .replace(/[\s·.,:;()\[\]0-9IVXLCM—–-]+/gi, '');
    return residue.length <= 8 ? '' : p;
  });
  // heading "Contents" left hanging after the list was removed
  out = out.replace(/<h([1-4])[^>]*>(?:(?!<\/h\1>)[\s\S])*?<\/h\1>\s*(?=<hr|<div|\n)/gi, (h, lvl, offset, full) => {
    return /^(contents|table of contents)\.?$/i.test(stripTags(h)) ? '' : h;
  });
  return out;
}

/**
 * Editorial/transcriber note blocks that mention Project Gutenberg (edition
 * lists, proofreader credits). Books from the 18th-19th century cannot
 * legitimately mention "Project Gutenberg" (founded 1971), so any block-level
 * mention is production boilerplate.
 */
function removePgMentionBlocks(html, isFirstDoc) {
  let out = html;
  const blockRe = /<p\b[\s\S]*?<\/p>|<blockquote\b[\s\S]*?<\/blockquote>|<table\b[\s\S]*?<\/table>|<h[1-6]\b[\s\S]*?<\/h[1-6]>|<li\b[\s\S]*?<\/li>/gi;
  if (isFirstDoc) {
    // edition lists / credits at the front may be link tables without the
    // textual phrase — safe to drop wholesale only in the first document
    out = out.replace(blockRe, (b) => (PG_PHRASE_RE.test(stripTags(b)) || /gutenberg\.org/i.test(b) ? '' : b));
  }
  // unwrap remaining links to gutenberg.org (keep inner text — footnote
  // cross-references in scholarly books must not lose their content);
  // self-closing anchors (<a ... />) are dropped outright
  out = out.replace(/<a\b[^>]*gutenberg[^>]*\/>/gi, '');
  out = out.replace(/<a\b[^>]*href="[^"]*gutenberg[^"]*"[^>]*>([\s\S]*?)<\/a>/gi, '$1');
  // now only blocks with the actual phrase are boilerplate
  out = out.replace(blockRe, (b) => (PG_PHRASE_RE.test(stripTags(b)) ? '' : b));
  // credits living in bare divs: remove the smallest enclosing div/section
  let guard = 0;
  while (guard++ < 20) {
    const m = out.match(/project\s+gutenberg/i);
    if (!m) break;
    const idx = out.indexOf(m[0]);
    let removed = false;
    for (let open = out.lastIndexOf('<div', idx); open >= 0; open = out.lastIndexOf('<div', open - 1)) {
      const closed = balancedSpan(out, open, 'div');
      if (closed === null) continue;
      if (closed <= idx) continue; // this div ends before the phrase
      if (closed - open > 4000) break; // too big — would eat content
      out = out.slice(0, open) + out.slice(closed);
      removed = true;
      break;
    }
    if (!removed) break; // leave it; validation will keep the original file
  }
  return out;
}

/** End offset (exclusive) of the balanced element starting at `open`, or null. */
function balancedSpan(html, open, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'gi');
  re.lastIndex = open;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) return m.index + m[0].length;
    } else if (!/\/>$/.test(m[0])) depth++;
  }
  return null;
}

function cleanHead(html) {
  return html
    .replace(/<meta\s+name="generator"[^>]*\/?>(\s*)/gi, '')
    .replace(/<meta\b[^>]*gutenberg[^>]*\/?>(\s*)/gi, '')
    .replace(/<link[^>]*type="image\/x-cover"[^>]*\/?>(\s*)/gi, '')
    .replace(/<title>([\s\S]*?)<\/title>/i, (m, t) => {
      const cleaned = t
        .replace(/\s*\|\s*Project\s+Gutenberg\s*/gi, '')
        .replace(/^\s*The\s+Project\s+Gutenberg\s+eBook\s+of\s*/i, '')
        .replace(/[,;]?\s*[—–-]?\s*an?\s+Project\s+Gutenberg\s+eBook\.?\s*$/i, '')
        .replace(/\s*Project\s+Gutenberg('s)?\s*/gi, ' ');
      return `<title>${cleaned.replace(/\s+/g, ' ').trim()}</title>`;
    });
}

function titlePageHtml(title, author, subtitle) {
  const subtitleLine = subtitle
    ? `\n      <p style="font-size: 0.85em; margin: 0.9em 0 0 0; opacity: 0.55;">${escapeXml(subtitle)}</p>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" dir="ltr">
  <head>
    <title>${escapeXml(title)}</title>
  </head>
  <body style="margin: 0; padding: 0; text-align: center; text-indent: 0;">
    <div style="padding: 38% 8% 0 8%;">
      <h1 style="font-size: 1.9em; font-weight: 600; line-height: 1.25; margin: 0 0 0.75em 0; letter-spacing: 0.01em;">${escapeXml(title)}</h1>
      <p style="font-size: 1.05em; margin: 0; opacity: 0.75;">${escapeXml(author)}</p>${subtitleLine}
    </div>
  </body>
</html>
`;
}

function displayTitle(rawTitle) {
  // "Moby Dick; Or, The Whale" -> main "Moby Dick", subtitle "Or, The Whale"
  // "She: A History of Adventure" -> main "She", subtitle "A History of Adventure"
  const semi = rawTitle.split(';');
  let main = semi[0].trim();
  let subtitle = semi.slice(1).join(';').trim() || null;
  if (!subtitle && main.includes(':')) {
    const ci = main.indexOf(':');
    subtitle = main.slice(ci + 1).trim();
    main = main.slice(0, ci).trim();
  }
  if (subtitle) subtitle = subtitle.replace(/^(or,?|a|an|the)\s+/i, (m) => m); // keep as-is
  return { main, subtitle };
}

// ---------------------------------------------------------------- per-book

function cleanBook(rec, report) {
  const epubPath = path.join(CATALOG_DIR, rec.file);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `clean-en-${rec.slug.slice(0, 24)}-`));
  try {
    extractEpub(epubPath, workDir);
    const container = fs.readFileSync(path.join(workDir, 'META-INF/container.xml'), 'utf8');
    const opfRel = container.match(/full-path="([^"]+)"/)[1];
    const opfPath = path.join(workDir, opfRel);
    const opfDir = path.dirname(opfPath);
    let opf = fs.readFileSync(opfPath, 'utf8');
    let changed = false;

    const items = new Map(); // id -> {href, type}
    for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
      const id = (m[0].match(/\bid="([^"]+)"/) || [])[1];
      const href = (m[0].match(/\bhref="([^"]+)"/) || [])[1];
      const type = (m[0].match(/media-type="([^"]+)"/) || [])[1] || '';
      if (id && href) items.set(id, { href, type });
    }
    const spineIds = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"[^>]*\/?>/g)].map((m) => m[1]);
    const isContentDoc = (id) => items.has(id) && /xhtml|html/i.test(items.get(id).type);

    const dropIds = new Set();
    const patterns = report.patterns;

    // --- 1. branded cover wrapper page(s) ---
    for (const id of spineIds) {
      if (!isContentDoc(id)) continue;
      const file = path.join(opfDir, decodeURIComponent(items.get(id).href));
      if (!fs.existsSync(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      const body = bodyOf(src);
      const hasImg = /<img\b/i.test(body);
      if (hasImg && stripTags(body).length < 5 && /x-ebookmaker-cover|cover/i.test(body)) {
        dropIds.add(id);
        patterns.coverPages++;
        // the referenced cover image file too
        const imgHref = (body.match(/<img\b[^>]*src="([^"]+)"/i) || [])[1];
        if (imgHref) {
          const imgAbs = path.join(path.dirname(file), decodeURIComponent(imgHref));
          fs.rmSync(imgAbs, { force: true });
          for (const [iid, it] of items) {
            if (path.join(opfDir, decodeURIComponent(it.href)) === imgAbs) {
              opf = opf.replace(new RegExp(`<item\\b[^>]*id="${escapeRe(iid)}"[^>]*\\/?>(\\s*)`), '');
              items.delete(iid);
            }
          }
        }
        changed = true;
      }
      break; // only the first spine doc can be the cover wrapper
    }

    // --- 2. pg-header / pg-footer / markers in every content doc ---
    const firstContentId = spineIds.find((sid) => isContentDoc(sid) && !dropIds.has(sid));
    for (const id of spineIds) {
      if (!isContentDoc(id) || dropIds.has(id)) continue;
      const file = path.join(opfDir, decodeURIComponent(items.get(id).href));
      if (!fs.existsSync(file)) continue;
      let src = fs.readFileSync(file, 'utf8');
      const orig = src;
      // NB: pg-start-separator is left to cutByMarkers — its "*** START" line
      // is the boundary that tells us where pre-text boilerplate ends.
      for (const needle of ['id="pg-header"', 'id="pg-machine-header"']) {
        const cut = removeBalancedElement(src, needle);
        if (cut !== null) { src = cut; patterns.pgHeaders++; }
      }
      {
        const cut = removeBalancedElement(src, 'id="pg-footer"');
        if (cut !== null) { src = cut; patterns.pgFooters++; }
      }
      if (START_RE.test(stripTags(src)) || END_RE.test(stripTags(src))) {
        const cut = cutByMarkers(src);
        if (cut !== null) { src = cut; patterns.markerCuts++; }
      }
      src = cleanHead(src);
      if (PG_PHRASE_RE.test(stripTags(bodyOf(src))) || /gutenberg\.org/i.test(bodyOf(src))) {
        const noNotes = removePgMentionBlocks(src, id === firstContentId);
        if (noNotes !== src) { src = noNotes; patterns.pgNoteBlocks++; }
      }
      // P24: transcriber credit lines pointing at PG infrastructure
      // ("Transcribed from the 1920 ... by David Price, email ccx074@pglaf.org")
      if (/pglaf\.org/i.test(src)) {
        const noCredits = src.replace(/<p\b[\s\S]*?<\/p>/gi, (p) => (/pglaf\.org/i.test(p) ? '' : p));
        if (noCredits !== src) {
          src = noCredits;
          patterns.pglafCredits = (patterns.pglafCredits || 0) + 1;
        }
      }
      if (src !== orig) {
        changed = true;
        if (stripTags(bodyOf(src)).length < 20) {
          dropIds.add(id); // header/footer lived in its own file
          patterns.droppedBoilerplateDocs++;
        } else {
          fs.writeFileSync(file, src, 'utf8');
        }
      }
    }

    // --- 3. inline TOC link sheets in the first two remaining content docs ---
    let scanned = 0;
    for (const id of spineIds) {
      if (!isContentDoc(id) || dropIds.has(id)) continue;
      if (scanned++ >= 2) break;
      const file = path.join(opfDir, decodeURIComponent(items.get(id).href));
      if (!fs.existsSync(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      const cleaned = removeInlineTocBlocks(src);
      if (cleaned !== src) {
        fs.writeFileSync(file, cleaned, 'utf8');
        patterns.inlineTocsRemoved++;
        changed = true;
      }
      // separate link-sheet TOC page -> linear="no" (nav/ncx keeps the real TOC)
      const body = bodyOf(cleaned);
      const anchors = (body.match(/<a\b[^>]*>/g) ?? []).length;
      const nonLink = stripTags(body.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, ''));
      if (anchors >= 5 && nonLink.length < 150 && !dropIds.has(id)) {
        const opfWas = opf;
        opf = opf.replace(
          new RegExp(`<itemref\\b([^>]*idref="${escapeRe(id)}"[^>]*)\\/?>`),
          (m, attrs) => /linear=/.test(m) ? m.replace(/linear="[^"]*"/, 'linear="no"') : `<itemref${attrs} linear="no"/>`,
        );
        if (opf !== opfWas) {
          patterns.tocPagesUnlinked++;
          changed = true;
        }
      }
    }

    // --- 4. drop removed docs from package ---
    for (const id of dropIds) {
      const href = items.get(id).href;
      fs.rmSync(path.join(opfDir, decodeURIComponent(href)), { force: true });
      opf = opf.replace(new RegExp(`<item\\b[^>]*id="${escapeRe(id)}"[^>]*\\/?>(\\s*)`), '');
      opf = opf.replace(new RegExp(`<itemref\\b[^>]*idref="${escapeRe(id)}"[^>]*\\/?>(\\s*)`, 'g'), '');
      // nav.xhtml / toc.ncx references
      for (const [nid, it] of items) {
        if (!/nav|ncx/.test(nid) && it.type !== 'application/x-dtbncx+xml') continue;
        const navFile = path.join(opfDir, decodeURIComponent(it.href));
        if (!fs.existsSync(navFile)) continue;
        let nav = fs.readFileSync(navFile, 'utf8');
        nav = nav
          .replace(new RegExp(`<navPoint\\b(?:(?!</navPoint>)[\\s\\S])*?src="${escapeRe(href)}[^"]*"[\\s\\S]*?</navPoint>`, 'g'), '')
          .replace(new RegExp(`<li\\b[^>]*>\\s*<a\\b[^>]*href="${escapeRe(href)}[^"]*"[^>]*>[\\s\\S]*?</a>\\s*</li>`, 'g'), '');
        fs.writeFileSync(navFile, nav, 'utf8');
      }
      items.delete(id);
    }

    // --- 5. NCX/nav: strip PG-branded entries and heal playOrder ---
    for (const [nid, it] of items) {
      const isNcx = it.type === 'application/x-dtbncx+xml';
      const isNav = /nav/.test(nid) || /nav\.xhtml$/.test(it.href);
      if (!isNcx && !isNav) continue;
      const navFile = path.join(opfDir, decodeURIComponent(it.href));
      if (!fs.existsSync(navFile)) continue;
      let nav = fs.readFileSync(navFile, 'utf8');
      const before = nav;
      nav = nav.replace(/<navPoint\b(?:(?!<\/navPoint>)[\s\S])*?<\/navPoint>/g, (np) =>
        /project\s+gutenberg|pg-header|pg-footer|full project gutenberg license/i.test(np) ? '' : np);
      nav = nav.replace(/<li\b[^>]*>\s*<a\b[^>]*>[^<]*<\/a>\s*<\/li>/g, (li) =>
        /project\s+gutenberg|pg-header|pg-footer/i.test(li) ? '' : li);
      nav = nav.replace(/<text>([^<]*)<\/text>/g, (m, t) => `<text>${t.replace(/^The Project Gutenberg eBook of\s*/i, '')}</text>`);
      nav = nav
        .replace(/(<meta\s+name="dtb:uid"\s+content=")[^"]*gutenberg[^"]*(")/i, `$1urn:narra:${rec.slug}$2`)
        .replace(/<meta\s+name="dtb:generator"[^>]*\/>\s*/gi, '');
      if (isNcx) {
        let order = 0;
        nav = nav.replace(/playOrder="\d+"/g, () => `playOrder="${++order}"`);
      }
      if (nav !== before) {
        fs.writeFileSync(navFile, nav, 'utf8');
        patterns.navEntriesScrubbed++;
        changed = true;
      }
    }

    // --- 5b. CSS files: PG docutils stylesheets carry branded comments ---
    for (const [, it] of items) {
      if (!/css/i.test(it.type)) continue;
      const cssFile = path.join(opfDir, decodeURIComponent(it.href));
      if (!fs.existsSync(cssFile)) continue;
      const css = fs.readFileSync(cssFile, 'utf8');
      const scrubbed = css.replace(/\/\*[\s\S]*?\*\//g, (c) => (/gutenberg/i.test(c) ? '' : c));
      if (scrubbed !== css) {
        fs.writeFileSync(cssFile, scrubbed, 'utf8');
        patterns.cssCommentsScrubbed = (patterns.cssCommentsScrubbed || 0) + 1;
        changed = true;
      }
    }

    // --- 6. title page (idempotent) ---
    const { main, subtitle } = displayTitle(rec.title);
    const titleFile = path.join(opfDir, 'narra-titlepage.xhtml');
    const titleHtml = titlePageHtml(main, rec.author, subtitle);
    if (!fs.existsSync(titleFile) || fs.readFileSync(titleFile, 'utf8') !== titleHtml) {
      fs.writeFileSync(titleFile, titleHtml, 'utf8');
      changed = true;
    }
    if (!opf.includes('id="narra-titlepage"')) {
      opf = opf.replace(/<manifest[^>]*>/, (m) =>
        `${m}\n    <item id="narra-titlepage" href="narra-titlepage.xhtml" media-type="application/xhtml+xml"/>`);
      opf = opf.replace(/(<spine[^>]*>)/, `$1\n    <itemref idref="narra-titlepage" linear="yes"/>`);
      patterns.titlePagesAdded++;
      changed = true;
    }

    // --- 7. OPF metadata scrub ---
    const opfBefore = opf;
    opf = opf
      .replace(/<dc:source>[\s\S]*?<\/dc:source>\s*/gi, '')
      .replace(/<dc:publisher>[^<]*Gutenberg[^<]*<\/dc:publisher>\s*/gi, '')
      .replace(/(<dc:identifier[^>]*>)[^<]*gutenberg[^<]*(<\/dc:identifier>)/gi, `$1urn:narra:${rec.slug}$2`)
      .replace(/<dc:rights>[^<]*Gutenberg[^<]*<\/dc:rights>\s*/gi, '<dc:rights>Public domain in the USA.</dc:rights>\n    ')
      .replace(/<meta\s+name="cover"[^>]*\/>\s*/gi, (m) => {
        const coverId = (m.match(/content="([^"]+)"/) || [])[1];
        return coverId && !items.has(coverId) ? '' : m;
      });
    if (opf !== opfBefore) changed = true;
    fs.writeFileSync(opfPath, opf, 'utf8');

    // --- 8. validation ---
    const errors = [];
    const finalSpineIds = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"[^>]*\/?>/g)].map((m) => m[1]);
    const finalContent = finalSpineIds.filter((id) => isContentDoc(id) || id === 'narra-titlepage');
    if (finalContent[0] !== 'narra-titlepage') errors.push('spine does not start with narra-titlepage');
    // titlepage + at least one content doc (short stories/poems collapse to 2)
    if (finalContent.length < 2) errors.push(`spine too short after clean: ${finalContent.length}`);
    let textBytes = 0;
    let firstContentPreview = '';
    for (let i = 0; i < finalContent.length; i++) {
      const id = finalContent[i];
      const href = id === 'narra-titlepage' ? 'narra-titlepage.xhtml' : items.get(id).href;
      const file = path.join(opfDir, decodeURIComponent(href));
      if (!fs.existsSync(file)) { errors.push(`missing spine file ${href}`); continue; }
      const text = stripTags(bodyOf(fs.readFileSync(file, 'utf8')));
      if (i === 0 && !text.includes(main.slice(0, 40))) errors.push(`title page lacks title: "${text.slice(0, 80)}"`);
      if (i > 0) textBytes += Buffer.byteLength(text);
      if (i === 1) firstContentPreview = text.slice(0, 200);
      if (PG_PHRASE_RE.test(text)) errors.push(`PG phrase left in ${href}: "${text.match(/.{0,60}project\s+gutenberg.{0,60}/i)?.[0]}"`);
      if (id !== 'narra-titlepage') {
        const raw = fs.readFileSync(file, 'utf8');
        if (/gutenberg\.org/i.test(raw)) errors.push(`gutenberg.org link left in ${href}`);
        if (PG_PHRASE_RE.test(raw)) errors.push(`PG phrase left in markup of ${href}`);
        if (/pglaf\.org/i.test(raw)) errors.push(`pglaf.org credit left in ${href}`);
      }
    }
    if (PG_PHRASE_RE.test(opf)) errors.push('PG phrase left in OPF');
    for (const [, it] of items) {
      if (!/xhtml|html|css|ncx|xml/i.test(it.type) && !/nav\.xhtml$/.test(it.href)) continue;
      const f = path.join(opfDir, decodeURIComponent(it.href));
      if (!fs.existsSync(f)) continue;
      const raw = fs.readFileSync(f, 'utf8');
      if (/project\s+gutenberg|gutenberg\.org/i.test(raw)) {
        errors.push(`Gutenberg reference left in ${it.href}`);
      }
    }
    const minText = rec.textBytes > 0 ? Math.min(rec.textBytes * 0.5, 40 * 1024) : 40 * 1024;
    if (textBytes < minText) errors.push(`text shrank too much: ${textBytes}`);

    report.firstContentPreview = firstContentPreview;
    report.errors = errors;
    if (errors.length > 0) return { ok: false, changed: false };

    if (changed) packEpub(workDir, epubPath);
    const buf = fs.readFileSync(epubPath);
    return {
      ok: true,
      changed,
      bytes: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      spineCount: finalContent.length,
      textBytes,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- main

function main() {
  const manifestPath = path.join(CATALOG_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let records = manifest;
  if (ONLY) records = manifest.filter((r) => r.slug === ONLY);
  if (LIMIT) records = records.slice(0, LIMIT);

  const totals = {
    cleaned: 0, unchanged: 0, failed: 0,
    patterns: {
      pgHeaders: 0, pgFooters: 0, markerCuts: 0, coverPages: 0, pgNoteBlocks: 0,
      droppedBoilerplateDocs: 0, inlineTocsRemoved: 0, tocPagesUnlinked: 0,
      navEntriesScrubbed: 0, titlePagesAdded: 0, pglafCredits: 0,
    },
    examples: [],
    failures: [],
  };

  for (const rec of records) {
    const report = { patterns: totals.patterns };
    let res;
    try {
      res = cleanBook(rec, report);
    } catch (e) {
      res = { ok: false };
      report.errors = [`exception: ${e.message}`];
    }
    if (!res.ok) {
      totals.failed++;
      rec.cleaned = false;
      totals.failures.push({ slug: rec.slug, errors: report.errors });
      console.log(`FAIL ${rec.slug}: ${report.errors?.join('; ')}`);
    } else {
      rec.cleaned = true;
      if (res.changed) {
        rec.bytes = res.bytes;
        rec.sha256 = res.sha256;
        rec.spineCount = res.spineCount;
        rec.textBytes = res.textBytes;
        totals.cleaned++;
      } else {
        totals.unchanged++;
      }
      if (totals.examples.length < 3 && res.changed) {
        totals.examples.push({ slug: rec.slug, firstContentAfterTitle: report.firstContentPreview });
      }
    }
    const done = totals.cleaned + totals.unchanged + totals.failed;
    if (done % 50 === 0) console.log(`progress: ${done}/${records.length}`);
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  fs.writeFileSync(path.join(CATALOG_DIR, 'clean-report.json'), JSON.stringify(totals, null, 1));
  console.log(`\nCLEAN DONE: cleaned=${totals.cleaned} unchanged=${totals.unchanged} failed=${totals.failed}`);
  console.log('patterns:', JSON.stringify(totals.patterns));
  if (totals.failed > 0) process.exitCode = 2;
}

main();
