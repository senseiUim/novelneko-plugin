const mangayomiSources = [{
  "name": "NovelNeko",
  "lang": "fr",
  "baseUrl": "https://novelneko.fr",
  "apiUrl": "",
  "iconUrl": "https://raw.githubusercontent.com/senseiUim/novelneko-plugin/main/icon.png",
  "typeSource": "single",
  "itemType": 2,
  "version": "0.0.1",
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

  /** Novel folder name from a catalogue link, a full URL or a stored path. */
  slugOf(link) {
    const slug = String(link || "")
      .replace(/^https?:\/\/[^\/]+/i, "")
      .replace(/^\.?\/?/, "")
      .replace(/^webnovels\//, "")
      .split(/[\/?#]/)[0];
    return slug ? slug : null;
  }

  toStatus(status) {
    const s = String(status || "").toLowerCase();
    if (/termin|compl|fini/.test(s)) return 1;
    if (/en cours|ongoing/.test(s)) return 0;
    if (/pause|hiatus/.test(s)) return 2;
    if (/abandon|annul/.test(s)) return 3;
    return 5;
  }

  async get(url) {
    const res = await new Client().get(url);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error("HTTP " + res.statusCode + " en chargeant " + url);
    }
    return res.body;
  }

  /** The whole catalogue is one JSON file: [{title, image, link, subtitle}]. */
  async catalog() {
    const body = await this.get(this.source.baseUrl + "/webnovels/webnovel.json?v=" + Date.now());
    let entries;
    try {
      entries = JSON.parse(body);
    } catch (e) {
      throw new Error("webnovel.json illisible");
    }
    if (!Array.isArray(entries)) throw new Error("Format inattendu pour webnovel.json");

    const list = [];
    for (const entry of entries) {
      const slug = entry.link ? this.slugOf(entry.link) : null;
      if (!slug || !entry.title) continue;
      list.push({
        name: entry.title,
        imageUrl: entry.image ? this.toAbsolute(entry.image) : "",
        link: this.source.baseUrl + "/webnovels/" + slug + "/",
      });
    }
    return list;
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

  // ----------------------------------------------------------- novel + text

  async getDetail(url) {
    const slug = this.slugOf(url);
    if (!slug) throw new Error("Adresse de roman invalide : " + url);
    const novelUrl = this.source.baseUrl + "/webnovels/" + slug + "/";

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
    const imageUrl = cover ? this.toAbsolute(cover, "/webnovels/" + slug + "/") : novelUrl + "cover.jpg";

    // Synopsis: every line after "Synopsis :" up to the buttons below it.
    let description = "";
    let start = -1;
    for (let i = 0; i < lines.length && start < 0; i++) {
      if (/^Synopsis\s*:?/i.test(lines[i])) start = i;
    }
    if (start >= 0) {
      const parts = [lines[start].replace(/^Synopsis\s*:?\s*/i, "")];
      for (let i = start + 1; i < lines.length; i++) {
        if (/^(Premier chapitre|Dernier chapitre|Chapitres disponibles)/i.test(lines[i])) break;
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
        if (!/^\d+\s+chapitres?$/i.test(lines[i])) continue;
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

    // Chapters: newest first, as the app expects.
    const count = this.chapterCount(html);
    if (count < 1) throw new Error("Impossible de déterminer le nombre de chapitres.");
    const chapters = [];
    for (let i = count; i >= 1; i--) {
      chapters.push({
        name: "Chapitre " + this.pad3(i),
        url: novelUrl + "lecture.html?chapitre=" + i,
        dateUpload: null,
        scanlator: null,
      });
    }

    return {
      name,
      imageUrl,
      description,
      author: field("Auteur"),
      artist: "",
      status: this.toStatus(field("Statut")),
      genre,
      chapters,
    };
  }

  async getHtmlContent(name, url) {
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
        text = res.body;
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
    throw new Error("getSourcePreferences not implemented");
  }
}
