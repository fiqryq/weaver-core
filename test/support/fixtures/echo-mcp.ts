import { appendFileSync } from "node:fs"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js"

// Lets tests count how many server processes were started.
if (process.env.ECHO_STARTS_FILE) appendFileSync(process.env.ECHO_STARTS_FILE, `${process.pid}\n`)

const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Repeats the text back.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
    },
    {
      name: "whoami.env",
      description: "Returns the ECHO_SECRET environment variable.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "fail",
      description: "Always fails.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "pid",
      description: "Returns the server's process ID.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "hang",
      description: "Blocks the server forever, so it stops answering anything.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "throw",
      description: "Answers with a JSON-RPC error.",
      inputSchema: { type: "object", properties: {} }
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "echo":
      return { content: [{ type: "text", text: `echo: ${String(request.params.arguments?.text ?? "")}` }] }
    case "whoami.env":
      return { content: [{ type: "text", text: process.env.ECHO_SECRET ?? "(unset)" }] }
    case "pid":
      return { content: [{ type: "text", text: String(process.pid) }] }
    case "hang":
      while (true) {
        // Busy-wait: the event loop never gets to answer pings or read stdin.
      }
    case "throw":
      throw new McpError(ErrorCode.InvalidParams, "bad arguments")
    default:
      return { content: [{ type: "text", text: "something broke" }], isError: true }
  }
})

await server.connect(new StdioServerTransport())
