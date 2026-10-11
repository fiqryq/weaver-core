import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { Duration, Effect } from "effect"
import { ToolFailure } from "../AgentTool.ts"

/** Checks a URL a bot wants to open, returning it parsed, or why it can't be opened. */
export type UrlGuard = (url: string) => Effect.Effect<URL, ToolFailure>

/** Resolves a host name to its addresses. */
export type Lookup = (hostname: string) => Promise<ReadonlyArray<string>>

const systemLookup: Lookup = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address)

const blockedV4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
]

const v4Number = (ip: string): number => ip.split(".").reduce((value, part) => value * 256 + Number(part), 0)

const isBlockedV4 = (ip: string): boolean => {
  const value = v4Number(ip)
  return blockedV4.some(([base, bits]) => Math.floor(value / 2 ** (32 - bits)) === Math.floor(v4Number(base) / 2 ** (32 - bits)))
}

/** The eight 16-bit groups of an IPv6 address. */
const v6Groups = (ip: string): Array<number> | undefined => {
  let address = ip.split("%")[0]!
  const embedded = address.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (embedded !== null) {
    const value = v4Number(embedded[1]!)
    address = `${address.slice(0, -embedded[1]!.length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`
  }
  const [head, tail] = address.split("::")
  const parse = (part: string | undefined) => (part ? part.split(":").map((group) => parseInt(group, 16)) : [])
  const start = parse(head)
  const end = parse(tail)
  const groups = tail === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill(0), ...end]
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : undefined
}

const v4From = (high: number, low: number): string => [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".")

const isBlockedV6 = (ip: string): boolean => {
  const groups = v6Groups(ip)
  if (groups === undefined) return true
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number]
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) addresses.
  if (zeroPrefix && (g5 === 0xffff || g5 === 0) && !(g5 === 0 && g6 === 0 && g7 <= 1)) return isBlockedV4(v4From(g6, g7))
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isBlockedV4(v4From(g6, g7))
  if (g0 === 0x2002) return isBlockedV4(v4From(g1, g2))
  if (zeroPrefix && g5 === 0 && g6 === 0) return true
  return (g0 & 0xfe00) === 0xfc00 ||
    (g0 & 0xffc0) === 0xfe80 ||
    (g0 & 0xffc0) === 0xfec0 ||
    (g0 & 0xff00) === 0xff00 ||
    (g0 === 0x2001 && g1 === 0xdb8)
}

/** Whether an IP address is private, loopback, link-local (cloud metadata included) or otherwise not on the public internet. */
export const isPrivateAddress = (ip: string): boolean => {
  const bare = ip.replace(/^\[|\]$/g, "")
  switch (isIP(bare.split("%")[0]!)) {
    case 4:
      return isBlockedV4(bare)
    case 6:
      return isBlockedV6(bare)
    default:
      return true
  }
}

const isLocalName = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname.endsWith(".local") ||
  hostname.endsWith(".internal") ||
  !hostname.includes(".")

/** Accepts `example.com/page` as `https://example.com/page`. */
export const parseWebUrl = (raw: string): URL | undefined => {
  const trimmed = raw.trim()
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return undefined
  }
}

/**
 * Only lets through http(s) URLs on the public internet: the host, and every address it resolves
 * to, must not be private, loopback or link-local, so bots can't reach the server's own network.
 */
export const publicUrl = (raw: string, resolve: Lookup = systemLookup): Effect.Effect<URL, ToolFailure> =>
  Effect.gen(function*() {
    const url = parseWebUrl(raw)
    if (url === undefined) return yield* new ToolFailure({ message: `${raw} isn't a valid URL.` })
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return yield* new ToolFailure({ message: `Only http and https pages can be opened, not ${url.protocol} URLs.` })
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase()
    const refuse = (detail: string) =>
      new ToolFailure({ message: `${url.host} is ${detail}; bots can only open pages on the public internet.` })
    if (isIP(hostname) !== 0) {
      if (isPrivateAddress(hostname)) return yield* refuse("a private or local address")
      return url
    }
    if (isLocalName(hostname)) return yield* refuse("a local name")
    const addresses = yield* Effect.tryPromise({
      try: () => resolve(hostname),
      catch: () => new ToolFailure({ message: `Couldn't find ${url.hostname}; check the address.` })
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(10),
        orElse: () => Effect.fail(new ToolFailure({ message: `Looking up ${url.hostname} took too long.` }))
      })
    )
    if (addresses.length === 0) return yield* new ToolFailure({ message: `Couldn't find ${url.hostname}; check the address.` })
    const blocked = addresses.find(isPrivateAddress)
    if (blocked !== undefined) return yield* refuse(`on a private or local address (${blocked})`)
    return url
  })
