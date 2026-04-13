export const metadata = {
  title: 'moltbank-kb-mcp',
  description: 'Remote MCP server for the moltbank-kb knowledge vault',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
