// The MCP server at /orthographic/mcp (Streamable HTTP, stateless): the tools
// of tools.ts, plus the guide and the schema as resources. State lives in the
// stored scenes, not in the MCP session, so any request can go to any process
// and a client that reconnects loses nothing.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { callTool, TOOLS, type ToolContext, type ToolOutput } from "./tools";

const MAX_BODY = 48 * 1024 * 1024;

const INSTRUCTIONS = `Orthographic Studio builds 3D scenes from flat outlines: each object is one closed polygon in each of three orthographic views (front x/z, top x/y, right side y/z), and its solid is the intersection of the three outlines extruded along their view directions. Z is up; Y is depth away from the front camera; outline points are world units.

Workflow: call read_guide once. create_scene (optionally from a whole document) gives a sceneId and an editorUrl; share the editorUrl with the user, who can watch and edit the same scene live. Add reference images with add_image (a public URL or base64) and set_reference. Build objects with add_objects in batches of about 20 (add_object for one; load_document replaces the whole scene). validate reports every problem with a JSON Pointer path; render returns PNGs of the views to compare with the references. Every edit is one undoable step (undo/redo) and reports the objects it touched and their geometry problems.

Only these tool calls change the scene: geometry drafted in your own workspace is not in it until a tool call returns ok. Render after the first batch, and confirm progress with get_scene before reporting it.`;

const RESOURCES = [
  {
    uri: "orthographic://guide",
    name: "guide",
    title: "Orthographic Studio guide",
    mimeType: "text/markdown",
    file: "../orthographic/llms.txt",
  },
  {
    uri: "orthographic://schema",
    name: "schema",
    title: "Scene document JSON Schema",
    mimeType: "application/schema+json",
    file: "../orthographic/src/core/schema.json",
  },
];

/** A tool's answer as MCP content: the JSON (without pixels) as text and structured content, renders as images. */
function toMcp(out: ToolOutput): CallToolResult {
  const { images, ...rest } = out;
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(rest) }];
  for (const [view, url] of Object.entries(images ?? {})) {
    content.push({ type: "text", text: `${view} view:` });
    content.push({ type: "image", mimeType: "image/png", data: url.replace(/^data:image\/png;base64,/, "") });
  }
  return { content, structuredContent: rest, isError: !out.ok };
}

function buildServer(ctx: ToolContext): Server {
  const server = new Server(
    {
      name: "orthographic-studio",
      title: "Orthographic Studio",
      version: "1.0.0",
      websiteUrl: `${ctx.origin}/orthographic/`,
    },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema as { type: "object" },
      annotations: {
        title: t.title,
        readOnlyHint: true,
        // Only add_image reaches outside this server (to fetch a URL).
        openWorldHint: t.name === "add_image",
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    toMcp(await callTool(req.params.name, req.params.arguments, ctx)),
  );
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES.map(({ file: _, ...r }) => r),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const r = RESOURCES.find((x) => x.uri === req.params.uri);
    if (!r) throw new Error(`Unknown resource ${req.params.uri}.`);
    return {
      contents: [{ uri: r.uri, mimeType: r.mimeType, text: await Bun.file(new URL(r.file, import.meta.url)).text() }],
    };
  });
  return server;
}

/** Answer one MCP HTTP request with a fresh server (stateless mode). */
export async function handleMcp(req: Request, ctx: ToolContext): Promise<Response> {
  const server = buildServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_BODY,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await server.close();
  }
}
