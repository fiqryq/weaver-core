import { describe, expect, it } from "@effect/vitest"
import type { Prompt } from "effect/ai"
import { compactToolResults } from "../../../src/features/runs/PromptBuilder.ts"

const round = (
  ...results: ReadonlyArray<{ name: string; output: string; isFailure?: boolean }>
): Array<Prompt.MessageEncoded> => [
  {
    role: "assistant",
    content: results.map((result, index) => ({ type: "tool-call" as const, id: `${result.name}-${index}`, name: result.name, params: {} }))
  },
  {
    role: "tool",
    content: results.map((result, index) => ({
      type: "tool-result" as const,
      id: `${result.name}-${index}`,
      name: result.name,
      isFailure: result.isFailure ?? false,
      result: result.output
    }))
  }
]

const outputs = (prompt: ReadonlyArray<Prompt.MessageEncoded>): Array<string> =>
  prompt.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) => (part.type === "tool-result" ? [String(part.result)] : []))
      : []
  )

const page = (label: string) => `URL: https://example.com/${label}\n\n${label.repeat(3000)}`
const isCleared = (output: string) => output.includes("cleared to save context")

describe("compactToolResults", () => {
  it("leaves a prompt within the budget as it is", () => {
    const prompt: Array<Prompt.MessageEncoded> = [
      { role: "system", content: "You are Ada." },
      { role: "user", content: "Look around" },
      ...round({ name: "read_file", output: "a".repeat(5000) }),
      ...round({ name: "run_command", output: "b".repeat(5000) })
    ]
    expect(compactToolResults(prompt)).toEqual(prompt)
  })

  it("clears an earlier browser page once a later browser result shows the page", () => {
    const prompt = [
      ...round({ name: "browser_navigate", output: page("first") }),
      ...round({ name: "browser_click", output: page("second") })
    ]
    const [first, second] = outputs(compactToolResults(prompt))
    expect(isCleared(first!)).toBe(true)
    expect(first).toContain("URL: https://example.com/first")
    expect(second).toBe(page("second"))
  })

  it("keeps the page a failed browser action left in place", () => {
    const failed = `Couldn't click e12: ${"x".repeat(1200)}`
    const prompt = [
      ...round({ name: "browser_navigate", output: page("first") }),
      ...round({ name: "browser_click", output: failed, isFailure: true }),
      ...round({ name: "read_file", output: "c".repeat(2000) })
    ]
    expect(outputs(compactToolResults(prompt))).toEqual([page("first"), failed, "c".repeat(2000)])
  })

  it("keeps the newest outputs within the budget and clears every older one", () => {
    const prompt = [
      ...round({ name: "web_fetch", output: "1".repeat(4000) }),
      ...round({ name: "web_fetch", output: "2".repeat(4000) }),
      ...round({ name: "web_fetch", output: "3".repeat(4000) }),
      ...round({ name: "web_fetch", output: "4".repeat(4000) })
    ]
    const compacted = outputs(compactToolResults(prompt, 10_000))
    expect(compacted.map(isCleared)).toEqual([true, true, false, false])
    expect(compacted[0]).toContain("call web_fetch again")
  })

  it("keeps the latest round whole even when it's over the budget", () => {
    const prompt = round({ name: "web_fetch", output: "1".repeat(8000) }, { name: "web_fetch", output: "2".repeat(8000) })
    expect(compactToolResults(prompt, 5000)).toEqual(prompt)
  })

  it("never clears short outputs", () => {
    const prompt = [
      ...round({ name: "write_file", output: "Wrote 5 characters to notes.txt." }),
      ...round({ name: "web_fetch", output: "2".repeat(8000) })
    ]
    expect(compactToolResults(prompt, 100)).toEqual(prompt)
  })

  it("leaves what it cleared the same in later rounds", () => {
    let prompt = [
      ...round({ name: "browser_navigate", output: page("first") }),
      ...round({ name: "browser_click", output: page("second") })
    ]
    prompt = compactToolResults(prompt)
    const cleared = outputs(prompt)[0]
    prompt = compactToolResults([...prompt, ...round({ name: "browser_click", output: page("third") })])
    expect(outputs(prompt)[0]).toBe(cleared)
  })
})
