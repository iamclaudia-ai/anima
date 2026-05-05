import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { LoggerLike } from "@anima/shared";
import type { ExtensionManager } from "./extensions";

export async function handleGatewayMcpRequest(
  req: globalThis.Request,
  extensions: ExtensionManager,
  log: LoggerLike,
): Promise<globalThis.Response> {
  const server = new Server(
    {
      name: "anima-extension-tools",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {
          listChanged: true,
        },
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: extensions.getMcpTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      annotations: tool.annotations,
      _meta: tool._meta,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    try {
      return (await extensions.handleMcpTool(
        name,
        (args ?? {}) as Record<string, unknown>,
      )) as CallToolResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("MCP tool call failed", { tool: name, error: message });
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  const response = await transport.handleRequest(req);
  queueMicrotask(() => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  return response;
}
