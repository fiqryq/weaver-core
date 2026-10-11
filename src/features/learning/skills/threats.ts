const filler = String.raw`(?:\w+\s+){0,8}`
const secretVar = String.raw`\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b`
const threatPatterns: ReadonlyArray<readonly [string, RegExp]> = [
  ["prompt_injection", new RegExp(String.raw`ignore\s+${filler}(previous|all|above|prior)\s+${filler}instructions`, "i")],
  ["sys_prompt_override", /system\s+prompt\s+override/i],
  ["disregard_rules", new RegExp(String.raw`disregard\s+${filler}(your|all|any)\s+${filler}(instructions|rules|guidelines)`, "i")],
  [
    "bypass_restrictions",
    new RegExp(String.raw`act\s+as\s+(if|though)\s+${filler}you\s+${filler}(have\s+no|don't\s+have)\s+${filler}(restrictions|limits|rules)`, "i")
  ],
  ["html_comment_injection", /<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->/i],
  ["hidden_div", /<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none/i],
  ["deception_hide", new RegExp(String.raw`do\s+not\s+${filler}tell\s+${filler}the\s+user`, "i")],
  ["exfil_curl", new RegExp(String.raw`curl\s+[^\n]{0,2048}${secretVar}`, "i")],
  ["exfil_wget", new RegExp(String.raw`wget\s+[^\n]{0,2048}${secretVar}`, "i")],
  ["read_secrets", /cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i],
  ["ssh_backdoor", /authorized_keys/i],
  [
    "ssh_access",
    /(?:\b(?:echo|cat|cp|mv|dd|tee|install|printf|rsync|scp|ln|append|add|write|sed|chmod|chown|truncate|rm|touch|curl|wget|git)\b|\bopen\s*\(|>>?)[^\n]{0,512}(?:\$HOME\/\.ssh|~\/\.ssh)/i
  ]
]
const hardcodedSecret = /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["']([A-Za-z0-9+/=_-]{20,})/gi
const envVarName = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/
const invisibleChars = /[\u200b\u200c\u200d\u2060\u2062\u2063\u2064\ufeff\u202a-\u202e\u2066-\u2069]/g
const maxScanChars = 65_536

/** Threat ids found in text, ported from Hermes' strict scan for content that ends up in the prompt. */
export const scanThreats = (content: string): ReadonlyArray<string> => {
  const text = content.slice(0, maxScanChars)
  const found = new Set<string>()
  for (const match of text.matchAll(invisibleChars)) {
    found.add(`invisible_unicode_U+${match[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
  }
  const normalized = text.normalize("NFKC")
  for (const [id, pattern] of threatPatterns) if (pattern.test(normalized)) found.add(id)
  for (const match of normalized.matchAll(hardcodedSecret)) {
    if (!envVarName.test(match[1]!)) found.add("hardcoded_secret")
  }
  return [...found]
}

/** A message for the first threat `after` adds that `before` didn't have, so editing an existing skill isn't blocked by what's already there. */
export const introducedThreat = (before: string, after: string): string | undefined => {
  const existing = new Set(scanThreats(before))
  const id = scanThreats(after).find((finding) => !existing.has(finding))
  if (id === undefined) return undefined
  if (id.startsWith("invisible_unicode_")) {
    return `Blocked: the content contains an invisible unicode character (${id.slice("invisible_unicode_".length)}), which can hide injected instructions.`
  }
  return `Blocked: the content matches the threat pattern "${id}". Skills are added to your instructions, ` +
    `so they can't contain prompt-injection or secret-exfiltration text.`
}
