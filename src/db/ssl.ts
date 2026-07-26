// Managed Postgres providers (Render, DigitalOcean, etc.) enforce SSL
// server-side regardless of whether the connection string says so — a URL
// missing `sslmode=require` doesn't mean the server accepts plaintext.
// Only skip SSL for connections that are actually local.
export function resolveSslMode(databaseUrl: string): 'require' | false {
  const { hostname } = new URL(databaseUrl);
  return hostname === 'localhost' || hostname === '127.0.0.1' ? false : 'require';
}
