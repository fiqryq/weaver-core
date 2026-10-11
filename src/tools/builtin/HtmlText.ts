const namedEntities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  zwj: "",
  zwnj: "",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  times: "×",
  divide: "÷",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  rarr: "→",
  larr: "←",
  uarr: "↑",
  darr: "↓"
}

export const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return namedEntities[entity.toLowerCase()] ?? match
  })

/** Text of an HTML fragment on one line, e.g. a link's title. */
export const inlineText = (html: string): string =>
  decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim()

/** Elements whose contents are never shown, skipped with everything inside them. */
const rawText = new Set(["script", "style", "noscript", "template", "textarea", "title"])
const hidden = new Set(["svg", "math", "iframe", "canvas", "object", "nav", "footer", "aside", "button", "select", "dialog"])
const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"])
const blocks = new Set([
  "address",
  "article",
  "blockquote",
  "body",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "form",
  "header",
  "hr",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "thead",
  "tr",
  "ul"
])

const attribute = (attributes: string, name: string): string | undefined => {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))
  return match === null ? undefined : decodeEntities(match[1] ?? match[2] ?? match[3] ?? "")
}

const isHidden = (attributes: string): boolean =>
  /(?:^|\s)hidden(?:\s|=|$)/i.test(attributes) ||
  /aria-hidden\s*=\s*["']?true/i.test(attributes) ||
  /style\s*=\s*["'][^"']*display\s*:\s*none/i.test(attributes)

/** The part of a page worth reading: its `<main>`, its only `<article>`, or else its `<body>`. */
const mainContent = (html: string): string => {
  const main = html.match(/<main[\s>][\s\S]*<\/main\s*>/i)
  if (main !== null) return main[0]
  const articles = html.match(/<article[\s>][\s\S]*?<\/article\s*>/gi)
  if (articles !== null && articles.length === 1) return articles[0]!
  const body = html.match(/<body[\s>][\s\S]*/i)
  return body !== null ? body[0] : html
}

export interface PageText {
  readonly title: string
  /** Readable text: headings as `#`, list items as `-`, and links as `text [n]`. */
  readonly text: string
  /** Link targets; `[n]` in the text is `links[n - 1]`. */
  readonly links: ReadonlyArray<string>
}

const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y

/** Converts an HTML page to readable text, without scripts, styles, navigation or hidden parts. */
export const htmlToText = (html: string, pageUrl?: string): PageText => {
  const title = inlineText(html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? "")
  const baseHref = html.match(/<base\s[^>]*href\s*=\s*["']?([^"'\s>]+)/i)?.[1]
  let base: URL | undefined
  try {
    base = pageUrl === undefined ? undefined : new URL(baseHref ?? "", pageUrl)
  } catch {
    base = undefined
  }

  const source = mainContent(html)
  const links: Array<string> = []
  const linkNumbers = new Map<string, number>()
  let out = ""
  let pre = 0
  let listDepth = 0
  let link: { href: string | undefined; start: number } | undefined
  /** The hidden element being skipped, with how deeply it's nested in itself. */
  let skipping: { tag: string; depth: number } | undefined

  const newline = (count = 1) => {
    const trimmed = out.replace(/[ \t]+$/, "")
    const existing = trimmed.length - trimmed.replace(/\n+$/, "").length
    out = trimmed + "\n".repeat(Math.max(count - existing, 0))
  }
  const text = (raw: string) => {
    const decoded = decodeEntities(raw)
    if (pre > 0) {
      out += decoded
      return
    }
    const collapsed = decoded.replace(/\s+/g, " ")
    out += out.length === 0 || /[\s]$/.test(out) ? collapsed.replace(/^ /, "") : collapsed
  }
  const resolveHref = (href: string | undefined): string | undefined => {
    if (href === undefined || href.startsWith("#") || /^(javascript|data|about):/i.test(href.trim())) return undefined
    try {
      const resolved = new URL(href.trim(), base)
      return /^(https?|mailto|ftp):$/.test(resolved.protocol) ? resolved.href : undefined
    } catch {
      return undefined
    }
  }

  let index = 0
  while (index < source.length) {
    const lt = source.indexOf("<", index)
    if (lt === -1) {
      if (skipping === undefined) text(source.slice(index))
      break
    }
    if (lt > index && skipping === undefined) text(source.slice(index, lt))
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4)
      index = end === -1 ? source.length : end + 3
      continue
    }
    if (source[lt + 1] === "!" || source[lt + 1] === "?") {
      const end = source.indexOf(">", lt)
      index = end === -1 ? source.length : end + 1
      continue
    }
    tagPattern.lastIndex = lt
    const match = tagPattern.exec(source)
    if (match === null) {
      if (skipping === undefined) text("<")
      index = lt + 1
      continue
    }
    index = tagPattern.lastIndex
    const closing = match[1] === "/"
    const tag = match[2]!.toLowerCase()
    const attributes = match[3] ?? ""
    const selfClosing = attributes.trimEnd().endsWith("/")

    if (!closing && rawText.has(tag)) {
      const closer = new RegExp(`</${tag}`, "gi")
      closer.lastIndex = index
      const end = closer.exec(source)?.index ?? -1
      index = end === -1 ? source.length : source.indexOf(">", end) + 1 || source.length
      continue
    }
    if (skipping !== undefined) {
      if (tag === skipping.tag && !voidTags.has(tag) && !selfClosing) {
        skipping.depth += closing ? -1 : 1
        if (skipping.depth === 0) skipping = undefined
      }
      continue
    }
    if (!closing && !voidTags.has(tag) && !selfClosing && (hidden.has(tag) || isHidden(attributes))) {
      skipping = { tag, depth: 1 }
      continue
    }

    const heading = /^h([1-6])$/.exec(tag)
    if (heading !== null) {
      newline(2)
      if (!closing) out += `${"#".repeat(Number(heading[1]))} `
      continue
    }
    switch (tag) {
      case "br":
        if (pre > 0) out += "\n"
        else newline()
        continue
      case "pre":
        newline(2)
        pre = Math.max(pre + (closing ? -1 : 1), 0)
        continue
      case "ul":
      case "ol":
        listDepth = Math.max(listDepth + (closing ? -1 : 1), 0)
        newline(listDepth === 0 ? 2 : 1)
        continue
      case "li":
        newline()
        if (!closing) out += `${"  ".repeat(Math.max(listDepth - 1, 0))}- `
        continue
      case "td":
      case "th":
        if (closing) out += " | "
        continue
      case "img": {
        const alt = attribute(attributes, "alt")?.trim()
        if (link !== undefined && alt) text(` ${alt} `)
        continue
      }
      case "a": {
        if (!closing) {
          link = { href: resolveHref(attribute(attributes, "href")), start: out.length }
          continue
        }
        if (link === undefined) continue
        const label = out.slice(link.start).trim()
        if (link.href !== undefined && label.length > 0) {
          let number = linkNumbers.get(link.href)
          if (number === undefined) {
            links.push(link.href)
            number = links.length
            linkNumbers.set(link.href, number)
          }
          out = `${out.replace(/\s+$/, "")} [${number}]`
        }
        link = undefined
        continue
      }
    }
    if (blocks.has(tag)) newline(tag === "p" || tag === "table" || tag === "blockquote" ? 2 : 1)
  }

  const lines = out.split("\n").map((line) => line.replace(/(?:\s*\|\s*)+$/, "").trimEnd())
  return {
    title,
    text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    links
  }
}

/** One page of a long text, cut at a line break when there's one near the end. */
export const pageOf = (text: string, offset: number, size: number): { body: string; start: number; next: number | undefined } => {
  const start = Math.min(Math.max(offset, 0), text.length)
  let end = Math.min(start + size, text.length)
  if (end < text.length) {
    const lineBreak = text.lastIndexOf("\n", end)
    if (lineBreak > start + size * 0.7) end = lineBreak + 1
  }
  return { body: text.slice(start, end), start, next: end < text.length ? end : undefined }
}
