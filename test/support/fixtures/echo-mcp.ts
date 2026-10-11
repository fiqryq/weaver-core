import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

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
    }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "echo":
      return { content: [{ type: "text", text: `echo: ${String(request.params.arguments?.text ?? "")}` }] }
    case "whoami.env":
      return { content: [{ type: "text", text: process.env.ECHO_SECRET ?? "(unset)" }] }
    default:
      return { content: [{ type: "text", text: "something broke" }], isError: true }
  }
})

await server.connect(new StdioServerTransport())
