# Manual Testing

## Prerequisites

- Node.js 20+
- AWS credentials
- An MCP endpoint hosted on AWS, using an IAM SigV4 authorization.

## Setup

```bash
git clone https://github.com/bchampp/mcp-proxy-for-aws-typescript
cd mcp-proxy-for-aws-typescript
npm install
npm run build
```

## 1. Unit Tests

```bash
npm test
```

Expected: 55 tests pass across 5 test files.

## 2. Library API (programmatic usage)

Create a file `test-integration.ts`:

```typescript
import { AwsIamStreamableHTTPClientTransport } from "./src/client.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

async function main() {
  const transport = new AwsIamStreamableHTTPClientTransport({
    url: "<your MCP server endpoint>",
    service: "execute-api",
    region: "us-east-1",
  });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(`Found ${tools.tools.length} tools:`);
  for (const tool of tools.tools) {
    console.log(`  - ${tool.name}: ${tool.description}`);
  }

  await client.close();
}

main().catch(console.error);
```

Run it:

```bash
npx tsx test-integration.ts
```

If it's working, you will see all the tools listed from the MCP client.

## 3. CLI / stdio Proxy

The CLI acts as a stdio proxy — it reads JSON-RPC from stdin and writes responses to stdout. Simulate an MCP client by piping messages with delays:

```bash
{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
  sleep 3
  echo '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  sleep 1
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  sleep 5
} | npx tsx src/bin/mcp-proxy-for-aws.ts <your MCP server endpoint> \
    --service execute-api --region us-east-1
```

Expected: Two JSON-RPC responses on stdout:

1. `id:1` — `initialize` response with `serverInfo: { name: "<your MCP server name>", version: "0.1.0" }`
2. `id:2` — `tools/list` response with tools and their full input schemas

## 4. MCP Client Integration

Add to your MCP client config (Claude Desktop, Kiro, etc.):

```json
{
  "mcpServers": {
    "<your MCP server>": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-proxy-for-aws-typescript/dist/bin/mcp-proxy-for-aws.js",
        "<your MCP server endpoint>",
        "--service", "execute-api",
        "--region", "us-east-1"
      ]
    }
  }
}
```

Verify: The MCP client should discover tools and be able to call them.
