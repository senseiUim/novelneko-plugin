const mangayomiSources = [{
  "name": "NovelNeko",
  "lang": "fr",
  "baseUrl": "https://novelneko.fr",
  "apiUrl": "",
  "iconUrl": "https://raw.githubusercontent.com/senseiUim/novelneko-plugin/main/icon.png",
  "typeSource": "single",
  "itemType": 2,
  "version": "0.0.6",
  "dateFormat": "",
  "dateFormatLocale": "",
  "pkgPath": "novelneko_mangayomi.js",
  "isNsfw": false,
  "hasCloudflare": false
}];

class DefaultExtension extends MProvider {
  // ---------------------------------------------------------------- helpers

  /** 1 -> "001", 42 -> "042", 1432 -> "1432" (same padding as the site). */
  pad3(n) {
    return n < 10 ? "00" + n : n < 100 ? "0" + n : String(n);
  }

  escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** Lower-case without accents, so "mysteres" finds "Mystères". */
  fold(text) {
    let s = String(text || "").toLowerCase();
    try {
      s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
    } catch (e) {
      // normalize() unavailable: keep the plain lower-case text
    }
    return s;
  }

  /** "x/cover.jpg", "./x/cover.jpg", "/webnovels/x/cover.jpg" or a full URL. */
  toAbsolute(value, baseDir) {
    if (/^https?:\/\//i.test(value)) return value;
    if (value.charAt(0) === "/") return this.source.baseUrl + value;
    return this.source.baseUrl + (baseDir || "/webnovels/") + value.replace(/^\.\//, "");
  }

  /** "webnovels" or "lightnovels", read from a URL or a stored path. */
  sectionOf(link) {
    return /\/lightnovels\//i.test(String(link || "")) ? "lightnovels" : "webnovels";
  }

  /** Novel folder name from a catalogue link, a full URL or a stored path. */
  slugOf(link) {
    const slug = String(link || "")
      .replace(/^https?:\/\/[^\/]+/i, "")
      .replace(/^\.?\/?/, "")
      .replace(/^(webnovels|lightnovels)\//, "")
      .split(/[\/?#]/)[0];
    return slug ? slug : null;
  }

  /** "02/06/2025" -> milliseconds since epoch as a string, or null. */
  parseDate(text) {
    const m = String(text || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return null;
    const t = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10)).getTime();
    return isNaN(t) ? null : String(t);
  }

  toStatus(status) {
    const s = String(status || "").toLowerCase();
    if (/termin|compl|fini/.test(s)) return 1;
    if (/en cours|ongoing/.test(s)) return 0;
    if (/pause|hiatus/.test(s)) return 2;
    if (/abandon|annul/.test(s)) return 3;
    return 5;
  }

  /**
   * The app decodes a response as Latin-1 when the server does not announce
   * a charset, which turns "é" into "Ã©". Detect that and put the UTF-8 back.
   * Text that is already correct is returned untouched (it is not valid
   * UTF-8 once re-read byte by byte, so the repair is rejected).
   */
  repairEncoding(text) {
    const s = String(text || "");
    if (!/[\u0080-ÿ]/.test(s) && !/[ŒœŠšŸŽžƒˆ˜–-›€™]/.test(s)) {
      return s; // plain ASCII: nothing to repair
    }
    // Characters Windows-1252 places where Latin-1 has control codes (0x80-0x9f).
    const cp1252 = {
      "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85,
      "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a,
      "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92,
      "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
      "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c,
      "ž": 0x9e, "Ÿ": 0x9f,
    };
    let encoded = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s.charAt(i);
      const code = s.charCodeAt(i);
      let byte = -1;
      if (code < 0x80 && ch !== "%") encoded += ch;
      else if (ch === "%") encoded += "%25";
      else if (code <= 0xff) byte = code;
      else if (cp1252[ch] !== undefined) byte = cp1252[ch];
      else return s; // a character no single-byte charset has: already proper text
      if (byte >= 0) encoded += "%" + ("0" + byte.toString(16)).slice(-2);
    }
    try {
      const fixed = decodeURIComponent(encoded);
      return fixed.indexOf("�") < 0 ? fixed : s;
    } catch (e) {
      return s; // not valid UTF-8: the text was fine as it was
    }
  }

  async get(url) {
    const res = await new Client().get(url);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error("HTTP " + res.statusCode + " en chargeant " + url);
    }
    return this.repairEncoding(res.body);
  }

  /** One catalogue file per section: [{title, image, link, subtitle}]. */
  async catalogOf(section) {
    const file = section === "lightnovels" ? "lightnovel.json" : "webnovel.json";
    const body = await this.get(this.source.baseUrl + "/" + section + "/" + file + "?v=" + Date.now());
    let entries;
    try {
      entries = JSON.parse(body);
    } catch (e) {
      throw new Error(file + " illisible");
    }
    if (!Array.isArray(entries)) throw new Error("Format inattendu pour " + file);

    const list = [];
    for (const entry of entries) {
      const slug = entry.link ? this.slugOf(entry.link) : null;
      if (!slug || !entry.title) continue;
      list.push({
        name: entry.title,
        imageUrl: entry.image ? this.toAbsolute(entry.image, "/" + section + "/") : "",
        link: this.source.baseUrl + "/" + section + "/" + slug + "/",
      });
    }
    return list;
  }

  /** Web novels then light novels. One section failing must not hide the other. */
  async catalog() {
    const lists = [];
    let firstError = null;
    for (const section of ["webnovels", "lightnovels"]) {
      try {
        lists.push(await this.catalogOf(section));
      } catch (e) {
        if (!firstError) firstError = e;
      }
    }
    if (lists.length === 0) throw firstError;
    return [].concat.apply([], lists);
  }

  /**
   * Plain-text view of a page, one line per block, so that labelled fields
   * ("Statut : Terminé") can be read whatever the exact markup is. Inline
   * elements get a \u0001 separator so that tags stay distinguishable.
   */
  linesOf(html) {
    const marked = html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|ul|ol|section|header|footer|tr|table)>/gi, "</$1>\n")
      .replace(/<\/(span|a|small|label|em|button)>/gi, "</$1>\u0001");
    const text = new Document(marked).body.text;
    return text
      .split("\n")
      .map((l) => l.replace(/[ \t\r\f\v ]+/g, " ").trim())
      .filter((l) => l.replace(/\u0001/g, "").trim().length > 0);
  }

  /** The novel page does not list chapters: the site numbers them 1..N. */
  chapterCount(html) {
    const declared = html.match(/maxChapitres\s*=\s*(\d+)/);
    if (declared) return parseInt(declared[1], 10);

    let max = 0;
    const linkRegex = /chapitre=(\d+)/g;
    let m;
    while ((m = linkRegex.exec(html)) !== null) {
      max = Math.max(max, parseInt(m[1], 10));
    }
    if (max > 0) return max;

    const label = html.match(/(\d+)\s*chapitres?/i);
    return label ? parseInt(label[1], 10) : 0;
  }

  // -------------------------------------------------------------- catalogue

  async getPopular(page) {
    // Single-file catalogue: there is only one page.
    if (page > 1) return { list: [], hasNextPage: false };
    return { list: await this.catalog(), hasNextPage: false };
  }

  async getLatestUpdates(page) {
    // The site exposes no "latest" feed, so this is the same catalogue.
    if (page > 1) return { list: [], hasNextPage: false };
    return { list: await this.catalog(), hasNextPage: false };
  }

  async search(query, page, filters) {
    if (page > 1) return { list: [], hasNextPage: false };
    const q = this.fold(query).trim();
    const all = await this.catalog();
    return {
      list: all.filter((novel) => this.fold(novel.name).indexOf(q) >= 0),
      hasNextPage: false,
    };
  }

  // ------------------------------------------- private reading repository

  preference(key, fallback) {
    try {
      const value = new SharedPreferences().get(key);
      const text = value === null || value === undefined ? "" : String(value).trim();
      return text.length > 0 ? text : fallback;
    } catch (e) {
      return fallback;
    }
  }

  readerToken() {
    return this.preference("github_token", "");
  }

  /** Page (GitHub Pages) that shows an illustration full screen. */
  viewerUrl() {
    return this.preference("viewer_url", "https://senseiuim.github.io/novelneko-plugin/viewer.html");
  }

  /** Turns the converter's illu://001.jpg links into links to the viewer page. */
  linkIllustrations(html, slug, tomeId) {
    const base = this.viewerUrl();
    const token = this.readerToken();
    const repo = this.readerRepo();
    return html.replace(/href="illu:\/\/([^"]+)"/g, (all, file) => {
      const path = "data/" + slug + "/" + tomeId + "/img/" + file;
      return (
        'href="' + base + "#r=" + encodeURIComponent(repo) + "&amp;p=" + encodeURIComponent(path) +
        "&amp;t=" + encodeURIComponent(token) + '"'
      );
    });
  }

  readerRepo() {
    return this.preference("github_repo", "senseiUim/novelneko-lecture");
  }

  /** "tome4-5.pdf" -> "tome4-5" (same rule as convert.py). */
  tomeId(url) {
    const file = String(url).split(/[?#]/)[0].replace(/^.*\//, "").replace(/\.pdf$/i, "");
    return file.toLowerCase().replace(/[^a-z0-9.\-]/g, "");
  }

  /** Reads a file of the private repository. null = not found; throws on a bad token. */
  async readerFile(path) {
    const url = "https://api.github.com/repos/" + this.readerRepo() + "/contents/" + path;
    const res = await new Client().get(url, {
      Authorization: "Bearer " + this.readerToken(),
      Accept: "application/vnd.github.raw+json",
      "User-Agent": "mangayomi-novelneko",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    if (res.statusCode === 404) return null;
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new Error("Jeton GitHub refusé ou expiré (HTTP " + res.statusCode + ").");
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error("HTTP " + res.statusCode + " en lisant " + path);
    }
    return this.repairEncoding(res.body);
  }

  /** Light novel chapters read from the private repository; PDF links for what is missing. */
  async readerChapters(slug, volumes) {
    if (!this.readerToken()) return volumes;
    let index = null;
    const text = await this.readerFile("data/" + slug + "/index.json");
    index = text ? JSON.parse(text) : null;
    if (!index || !Array.isArray(index.tomes)) return volumes;

    const known = {};
    for (const tome of index.tomes) known[tome.id] = tome;
    const chapters = [];
    for (const volume of volumes) {
      const tome = known[this.tomeId(volume.url)];
      if (!tome || !Array.isArray(tome.parts) || tome.parts.length === 0) {
        chapters.push(volume);
        continue;
      }
      for (let i = tome.parts.length - 1; i >= 0; i--) {
        const part = tome.parts[i];
        chapters.push({
          name: volume.name + " — " + part.title,
          url: volume.url + "?partie=" + part.n,
          // one second apart so that sorting by date keeps the parts in reading order
          dateUpload: volume.dateUpload ? String(parseInt(volume.dateUpload, 10) + part.n * 1000) : null,
          // Mangayomi merges chapters whose names carry the same first number ("Tome 1 ...");
          // a distinct scanlator per part keeps every part of the tome in the list.
          scanlator: "Partie " + part.n + "/" + tome.parts.length,
        });
      }
    }
    return chapters;
  }

  /** Page shown for a volume that is not available in the reading repository. */
  pdfPage(name, url) {
    const pdf = /^https?:\/\//i.test(String(url)) ? String(url) : this.source.baseUrl + url;
    const tome = pdf.match(/tome([\d.\-]+)\.pdf/i);
    const label = tome ? "Tome " + tome[1].replace("-", ".") : "Ce tome";
    const safe = pdf.replace(/"/g, "%22");
    const hint = this.readerToken()
      ? "<p>Ce tome n'a pas encore été converti dans ton dépôt de lecture (la conversion tourne chaque jour, ou lance-la à la main dans l'onglet Actions de GitHub).</p>"
      : "<p>Pour lire les tomes directement dans l'application, renseigne ton jeton GitHub dans les réglages de l'extension.</p>";
    return (
      "<h2>" + this.escapeHtml(String(name || "")) + " — " + label + "</h2>" +
      "<p>NovelNeko publie ce tome au format PDF, que Mangayomi ne sait pas afficher.</p>" +
      hint +
      "<p>En attendant, ouvre le PDF avec ce lien :</p>" +
      '<p><a href="' + safe + '">' + this.escapeHtml(pdf) + "</a></p>" +
      "<p>Si le lien ne s'ouvre pas bien ici, utilise l'option « Ouvrir dans le navigateur » du lecteur.</p>"
    );
  }

  // ----------------------------------------------------------- novel + text

  /** Light novels: the volumes are listed in the page as PDF links, newest first. */
  volumesOf(doc, html, baseDir) {
    const volumes = [];
    const seen = {};
    const add = (href, name, date) => {
      if (!href || seen[href]) return;
      seen[href] = true;
      volumes.push({
        name: name || href.replace(/^.*\//, "").replace(/\.pdf$/i, ""),
        url: this.toAbsolute(href, baseDir),
        dateUpload: this.parseDate(date),
        scanlator: null,
      });
    };
    for (const item of doc.select(".chapter-item")) {
      const link = item.selectFirst("a");
      add(link.attr("href"), link.text.trim(), item.selectFirst("span").text);
    }
    if (volumes.length === 0) {
      const re = /<a[^>]+href="([^"]+\.pdf)"[^>]*>([^<]*)<\/a>/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const label = m[2].trim();
        if (/^(premier|dernier)/i.test(label)) continue;
        add(m[1], label, "");
      }
    }
    // Highest tome number first (8, 7.5, 7, ...), as the app expects newest first.
    const num = (v) => {
      const m = String(v.name).match(/(\d+(?:[.,]\d+)?)/);
      return m ? parseFloat(m[1].replace(",", ".")) : null;
    };
    if (volumes.every((v) => num(v) !== null)) volumes.sort((a, b) => num(b) - num(a));
    return volumes;
  }

  async getDetail(url) {
    const section = this.sectionOf(url);
    const slug = this.slugOf(url);
    if (!slug) throw new Error("Adresse de roman invalide : " + url);
    const baseDir = "/" + section + "/" + slug + "/";
    const novelUrl = this.source.baseUrl + baseDir;

    const html = await this.get(novelUrl);
    const doc = new Document(html);

    const rawLines = this.linesOf(html);
    const lines = rawLines.map((l) => l.replace(/\u0001/g, " ").replace(/\s+/g, " ").trim());

    const field = (label) => {
      const re = new RegExp("^" + label + "\\s*:\\s*(.*)$", "i");
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (m) return m[1] || lines[i + 1] || "";
      }
      return "";
    };

    // Title and cover
    let name = doc.selectFirst("h1").text.trim();
    if (!name) {
      name = doc.selectFirst("title").text.replace(/\s*[-–—]\s*NovelNeko\s*$/i, "").trim();
    }
    const cover = doc.selectFirst(".cover").attr("src");
    const imageUrl = cover ? this.toAbsolute(cover, baseDir) : novelUrl + "cover.jpg";

    // Synopsis: every line after "Synopsis :" up to the buttons below it.
    const endOfSynopsis = /^(Premier (chapitre|tome)|Dernier (chapitre|tome)|Chapitres disponibles|Tomes? disponibles)/i;
    let description = "";
    let start = -1;
    for (let i = 0; i < lines.length && start < 0; i++) {
      if (/^Synopsis\s*:?/i.test(lines[i])) start = i;
    }
    if (start >= 0) {
      const parts = [lines[start].replace(/^Synopsis\s*:?\s*/i, "")];
      for (let i = start + 1; i < lines.length; i++) {
        if (endOfSynopsis.test(lines[i])) break;
        parts.push(lines[i]);
      }
      description = parts.filter((p) => p.length > 0).join("\n");
    }

    // Genres: tagged elements, else the elements right below "N chapitres".
    let genre = doc
      .select(".genres a, .genres span, .genre, .tags a, .tags span, .tag")
      .map((el) => el.text.trim())
      .filter((g) => g.length > 0);
    if (genre.length === 0) {
      for (let i = 0; i < lines.length; i++) {
        if (!/^\d+\s+(chapitres?|tomes?)$/i.test(lines[i])) continue;
        const found = [];
        for (let j = i + 1; j < rawLines.length && j <= i + 3; j++) {
          if (/^Synopsis/i.test(lines[j])) break;
          rawLines[j]
            .split("\u0001")
            .map((s) => s.replace(/\s+/g, " ").trim())
            .filter((s) => s.length > 0)
            .forEach((s) => found.push(s));
        }
        const plausible = found.length > 0 && found.length <= 12 && found.every((g) => g.length <= 30);
        if (plausible) genre = found;
        break;
      }
    }

    // Chapters, newest first as the app expects.
    let chapters = [];
    if (section === "lightnovels") {
      chapters = this.volumesOf(doc, html, baseDir);
      if (chapters.length === 0) throw new Error("Aucun tome trouvé sur la page.");
      chapters = await this.readerChapters(slug, chapters);
    } else {
      const count = this.chapterCount(html);
      if (count < 1) throw new Error("Impossible de déterminer le nombre de chapitres.");
      for (let i = count; i >= 1; i--) {
        chapters.push({
          name: "Chapitre " + this.pad3(i),
          url: novelUrl + "lecture.html?chapitre=" + i,
          dateUpload: null,
          scanlator: null,
        });
      }
    }

    return {
      name,
      imageUrl,
      description,
      author: field("Auteur"),
      artist: field("Illustrateur"),
      status: this.toStatus(field("Stat(?:ut|us)")),
      genre,
      chapters,
    };
  }

  async getHtmlContent(name, url) {
    // Light novels: parts converted by the private GitHub repository, else a link to the PDF.
    if (/\.pdf(\?|#|$)/i.test(String(url))) {
      const partMatch = String(url).match(/lightnovels\/([^\/?#]+)\/volumes\/([^\/?#]+)\.pdf\?partie=(\d+)/i);
      if (partMatch && this.readerToken()) {
        const number = ("0" + partMatch[3]).slice(-2);
        const text = await this.readerFile("data/" + partMatch[1] + "/" + this.tomeId(partMatch[2]) + "/" + number + ".html");
        if (text) return this.linkIllustrations(text, partMatch[1], this.tomeId(partMatch[2]));
      }
      return this.pdfPage(name, String(url).split("?")[0]);
    }
    const slugMatch = String(url).match(/webnovels\/([^\/?#]+)\//);
    const numberMatch = String(url).match(/[?&]chapitre=(\d+)/);
    if (!slugMatch || !numberMatch) throw new Error("Adresse de chapitre invalide : " + url);
    const slug = slugMatch[1];
    const n = parseInt(numberMatch[1], 10);
    const padded = this.pad3(n);

    // Same file names, in the same order, as the site's own reader tries.
    const names = [
      "chapitre_" + padded + "_fr.txt",
      "chapitre_" + padded + ".txt",
      "Chapitre_" + padded + ".txt",
      "chapitre-" + padded + ".txt",
      padded + ".txt",
      "chapitre_" + n + "_fr.txt",
      "chapitre_" + n + ".txt",
      "chapitre_" + n + "/chapter.txt",
      "chapitre_" + n + "/text.txt",
      "chapitre_" + n + "/content.txt",
    ];
    const tried = {};

    for (const file of names) {
      if (tried[file]) continue;
      tried[file] = true;

      let text;
      try {
        const res = await new Client().get(this.source.baseUrl + "/webnovels/" + slug + "/chapters/" + file);
        if (res.statusCode < 200 || res.statusCode >= 300) continue;
        text = this.repairEncoding(res.body);
      } catch (e) {
        continue;
      }
      // A missing file must not be mistaken for a chapter (error pages).
      if (/^\s*<(!doctype|html)/i.test(text)) continue;

      const paragraphs = text
        .split(/\r\n|\r|\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => "<p>" + this.escapeHtml(line) + "</p>");
      if (paragraphs.length > 0) return paragraphs.join("");
    }

    throw new Error("Chapitre " + n + " introuvable sur le site.");
  }

  async cleanHtmlContent(html) {
    return html;
  }

  getFilterList() {
    return [];
  }

  getSourcePreferences() {
    return [
      {
        key: "github_token",
        editTextPreference: {
          title: "Jeton GitHub (lecture des light novels)",
          summary: "Colle ici ton jeton GitHub en lecture seule",
          value: "",
          dialogTitle: "Jeton GitHub",
          dialogMessage: "Jeton à grain fin, lecture seule (Contents), limité à ton dépôt de lecture.",
          text: "",
        },
      },
      {
        key: "viewer_url",
        editTextPreference: {
          title: "Page d'affichage des illustrations",
          summary: "Adresse de viewer.html sur ton GitHub Pages",
          value: "https://senseiuim.github.io/novelneko-plugin/viewer.html",
          dialogTitle: "Page d'affichage des illustrations",
          dialogMessage: "Par exemple : https://senseiuim.github.io/novelneko-plugin/viewer.html",
          text: "https://senseiuim.github.io/novelneko-plugin/viewer.html",
        },
      },
      {
        key: "github_repo",
        editTextPreference: {
          title: "Dépôt de lecture",
          summary: "Nom du dépôt privé, au format propriétaire/dépôt",
          value: "senseiUim/novelneko-lecture",
          dialogTitle: "Dépôt de lecture",
          dialogMessage: "Par exemple : senseiUim/novelneko-lecture",
          text: "senseiUim/novelneko-lecture",
        },
      },
    ];
  }
}
