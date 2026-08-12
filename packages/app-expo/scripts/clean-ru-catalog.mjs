#!/usr/bin/env node
/**
 * clean-ru-catalog.mjs — P24: дочистка русского каталога (500 книг Викитеки)
 * от ВСЕХ следов Викитеки/Wikisource. Дополняет generic-чистку, которую делал
 * fetch-ru-catalog.mjs (она оставляла about.xhtml и метаданные OPF нетронутыми).
 *
 * Для каждой книги в каталоге (сама чистка — deepScrubWikisourceDir в
 * scripts/lib/epub-clean-lib.mjs, общая с clean-catalog-books.mjs):
 *  1. Страница «Об этом электронном издании» (about.xhtml): удаляется из
 *     спайна, манифеста, nav.xhtml (toc + landmarks) и toc.ncx; файл стирается.
 *  2. OPF: dc:identifier (ссылка на ru.wikisource.org) → urn:narra:ru:<slug>;
 *     dc:source удаляется; dc:contributor «Wikisource» (+refines) удаляется;
 *     префикс «автор » в dc:creator убирается. toc.ncx: dtb:uid → тот же urn,
 *     docAuthor без префикса «автор ».
 *  3. main.css: комментарии с упоминанием Wikisource/WS Export удаляются.
 *  4. Контент: ambox-баннеры MediaWiki («Источник текста не указан», «Что
 *     содержит Викитека») удаляются целиком; «Примечание редактора Викитеки» →
 *     «Примечание редактора»; пункты списков «Викитека:…» удаляются; ссылки на
 *     wikisource.org разворачиваются в текст; utm_source=ru.wikisource.org
 *     вычищается из атрибутов.
 *  5. Картинки с «_utm_source_ru.wikisource.org…» в имени файла переименовываются
 *     (суффикс отрезается), ссылки в OPF/контенте обновляются; картинки, на
 *     которые после чистки никто не ссылается, удаляются вместе с manifest-item.
 *  6. Титул: подзаголовок «перевод: Фамилия» → «перевод <родительный падеж>»
 *     (без двоеточий-лейблов, склонение по полу переводчика).
 *  7. Верификация по распакованному дереву: «викитек», «wikisource»,
 *     «народном достоянии», «Об этом электронном издании», «Экспортировано»,
 *     «Автор:»/«перевод:» в титуле — должно быть 0 вхождений, иначе книга
 *     не перепаковывается (оригинал сохраняется) и помечается ошибкой.
 *
 * Идемпотентно: повторный запуск ничего не меняет.
 * Запуск: node scripts/clean-ru-catalog.mjs [--dir <каталог>] [--only slug]
 * Зависимости: node + системные zip/unzip.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deepScrubWikisourceDir,
  extractEpub,
  findWikisourceTraces,
  packEpub,
} from "./lib/epub-clean-lib.mjs";

const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const CATALOG_DIR = argOf("--dir") || "/Users/aleksandr/Documents/ReadAny-catalog-ru";
const ONLY = argOf("--only");

/**
 * Подзаголовки перевода для титулов: «перевод: Фамилия» (лейбл с двоеточием,
 * фамилия в именительном падеже) → «перевод <имя в родительном падеже>».
 * Пол переводчика выверен по метаданным OPF (meta-trl) и страницам
 * Автор: в Викитеке; несклоняемые женские фамилии дополнены именем,
 * у переводчиков с неустановленным полом (М. И. Манн, Г. И. Гордон)
 * оставлены инициалы с несклоняемой фамилией.
 */
const TRANSLATOR_SUBTITLE = {
  ajvengo: "перевод Бекетовой",
  "borba-mirov": "перевод Пименовой",
  burya: "перевод Сатина",
  "dalnejshie-priklyucheniya-robinzona-kruzo": "перевод Журавской",
  "deti-kapitana-granta": "перевод Бекетовой",
  "dikie-lebedi": "перевод Анны Ганзен",
  "don-zhuan": "перевод Козлова",
  "dred-ili-povest-o-proklyatom-bolote": "перевод Бутузова",
  "dvadcat-tysyach-le-pod-vodoj": "перевод Марко Вовчок",
  "edip-v-kolone": "перевод Мережковского",
  "evgeniya-grande": "перевод Достоевского",
  faust: "перевод Холодковского",
  "gamlet-princ-datskij": "перевод Россова",
  "gospozha-bovari": "перевод Ромма",
  iliada: "перевод Гнедича",
  kain: "перевод Бунина",
  "kolodec-i-mayatnik": "перевод Бальмонта",
  kolomba: "перевод Гаршина",
  "kopi-carya-solomona": "перевод Бекетовой",
  "korol-lir": "перевод Дружинина",
  "kroshka-dorrit": "перевод Энгельгардта",
  "kukolnyj-dom": "перевод А. и П. Ганзен",
  "kventin-dorvard": "перевод Шишмарёвой",
  "malenkij-chelovek": "перевод Марины Лихтенштадт",
  malysh: "перевод Барбашевой",
  manfred: "перевод Бунина",
  "martin-iden": "перевод Заяицкого",
  "master-ballantre": "перевод М. И. Манн",
  "meschanin-vo-dvoryanstve": "перевод Лихачёва",
  mizantrop: "перевод Холодковского",
  "morskoj-volk": "перевод Вершининой",
  "nevesta-solnca": "перевод Журавской",
  "novye-sily": "перевод Жихаревой",
  "numa-rumestan": "перевод Загуляевой",
  otverzhennye: "перевод Виноградова",
  "pisma-starka-monro": "перевод Энгельгардта",
  "portret-doriana-greya": "перевод Ликиардопуло",
  "princ-i-nischij": "перевод Ясинского",
  "princ-otto": "перевод Марковича",
  "puteshestviya-lemyuelya-gullivera": "перевод Франковского",
  "richard-iii": "перевод Кюхельбекера",
  "robinzon-kruzo": "перевод Шишмарёвой",
  "romeo-i-dzhuletta": "перевод Михаловского",
  rusalochka: "перевод Анны Ганзен",
  salambo: "перевод Минского",
  salomeya: "перевод Бальмонта",
  "schelkunchik-i-myshinyj-korol": "перевод Соколовского",
  "shagrenevaya-kozha": "перевод Аверкиева",
  "silna-kak-smert": "перевод Сологуба",
  "skazka-bochki": "перевод Франковского",
  skupoj: "перевод Лихачёва",
  "snezhnaya-koroleva": "перевод Анны Ганзен",
  "soki-zemli": "перевод Жихаревой",
  "starshiny-vilbajskoj-shkol": "перевод Шишмарёвой",
  "stranica-lyubvi": "перевод Столярова",
  "tajna-korablya": "перевод Энгельгардта",
  "ubijstvo-na-ulice-morg": "перевод Бальмонта",
  "uchitel-fehtovaniya": "перевод Г. И. Гордон",
  "usmirenie-svoenravnoj": "перевод Островского",
  "venecianskij-kupec": "перевод Вейнберга",
  "yulij-cezar": "перевод Фета",
  "zhenskaya-vojna": "перевод Строева",
  "zhitejskie-vozzreniya-kota-murra": "перевод Бальмонта",
  zhizn: "перевод Чеботаревской",
  "zolotoj-gorshok": "перевод Соловьёва",
  "zolotoj-zhuk": "перевод Бальмонта",
  "zov-predkov": "перевод Вершининой",
};

// ------------------------------------------------------------ титул

function fixTitleSubtitle(opsDir, slug, report) {
  const titlePath = path.join(opsDir, "title.xhtml");
  if (!fs.existsSync(titlePath)) return;
  let t = fs.readFileSync(titlePath, "utf8");
  const before = t;
  const wanted = TRANSLATOR_SUBTITLE[slug];
  if (wanted) {
    t = t.replace(/(>)\s*перевод:\s*[^<]+(<)/, `$1${wanted}$2`);
  }
  // страховка: любые остаточные лейблы с двоеточием
  t = t.replace(/(>)\s*Автор:\s*/g, "$1");
  if (t !== before) {
    fs.writeFileSync(titlePath, t, "utf8");
    report.titleFixed = true;
  }
}

// ------------------------------------------------------------ верификация

function validateStructure(opsDir, hits) {
  const opf = fs.readFileSync(path.join(opsDir, "content.opf"), "utf8");
  const items = new Map(
    [...opf.matchAll(/<item\b[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*\/>/g)].map((m) => [m[1], m[2]]),
  );
  const spine = [...opf.match(/<spine[^>]*>[\s\S]*?<\/spine>/)[0].matchAll(/idref="([^"]+)"/g)].map((m) => m[1]);
  if (spine.length < 2) hits.push(`спайн слишком короткий: ${spine.length}`);
  if (spine[0] !== "title") hits.push(`спайн начинается не с титула: ${spine[0]}`);
  for (const [id, href] of items) {
    if (!fs.existsSync(path.join(opsDir, href))) hits.push(`манифест ссылается на отсутствующий файл: ${id} → ${href}`);
  }
  for (const id of spine) {
    if (!items.has(id)) hits.push(`спайн ссылается на отсутствующий item: ${id}`);
  }
  for (const nf of ["nav.xhtml", "toc.ncx"]) {
    const p = path.join(opsDir, nf);
    if (!fs.existsSync(p)) continue;
    const s = fs.readFileSync(p, "utf8");
    for (const m of s.matchAll(/(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)) {
      const target = m[1];
      if (/^[a-z]+:/.test(target)) continue;
      if (!fs.existsSync(path.join(opsDir, target))) hits.push(`${nf} ссылается на отсутствующий файл: ${target}`);
    }
  }
  const titleHref = items.get("title");
  if (titleHref) {
    const t = fs.readFileSync(path.join(opsDir, titleHref), "utf8").toLowerCase();
    if (t.includes("автор:")) hits.push("титул содержит лейбл «Автор:»");
    if (t.includes("перевод:")) hits.push("титул содержит лейбл «перевод:»");
  }
}

// ---------------------------------------------------------------- main

function main() {
  const epubs = fs
    .readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith(".epub"))
    .filter((f) => !ONLY || path.basename(f, ".epub") === ONLY)
    .sort();
  let failed = 0;
  let cleaned = 0;
  for (const file of epubs) {
    const slug = path.basename(file, ".epub");
    const epubPath = path.join(CATALOG_DIR, file);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `clean-ru-${slug}-`));
    const report = {};
    try {
      extractEpub(epubPath, workDir);
      const opsDir = path.join(workDir, "OPS");
      if (!fs.existsSync(opsDir)) {
        console.error(`✗ ${slug}: нет OPS/ — неожиданная структура, пропуск`);
        failed += 1;
        continue;
      }
      deepScrubWikisourceDir(workDir, slug, report);
      fixTitleSubtitle(opsDir, slug, report);

      const hits = findWikisourceTraces(workDir);
      validateStructure(opsDir, hits);
      if (hits.length === 0) {
        packEpub(workDir, epubPath);
        cleaned += 1;
        const notes = [
          report.aboutRemoved && "about",
          report.imageRenames && `${report.imageRenames} img-rename`,
          report.orphanImagesDropped && `${report.orphanImagesDropped} img-drop`,
          report.titleFixed && "титул",
        ]
          .filter(Boolean)
          .join(", ");
        console.log(`✓ ${slug}${notes ? ` (${notes})` : ""}`);
      } else {
        failed += 1;
        console.error(`✗ ${slug}: не перепакован`);
        for (const h of hits.slice(0, 10)) console.error(`    ${h}`);
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
  console.log(`\nИтого: очищено ${cleaned}, с ошибками ${failed}, всего ${epubs.length}`);
  if (failed > 0) process.exit(1);
}

main();
