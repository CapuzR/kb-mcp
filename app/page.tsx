export const dynamic = 'force-static';

export default function RootPage() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 48, maxWidth: 640 }}>
      <h1>moltbank-kb-mcp</h1>
      <p>
        This is a private MCP endpoint. Programmatic clients should POST JSON-RPC to{' '}
        <code>/api/mcp</code> with a bearer token.
      </p>
      <p>
        See <code>/api/health</code> for status.
      </p>
    </main>
  );
}
