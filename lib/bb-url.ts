// The URL a person uses to open BB, for "open this thread" links in GitHub
// replies. BB itself usually listens on loopback only, so when no app URL is
// configured, look for a Tailscale Serve entry that proxies to it.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface ServeStatus {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

/** The public origin that proxies `/` to `loopback`, from `tailscale serve status --json`. */
export function originFromServeStatus(status: ServeStatus, loopback: string): string | null {
  let target: URL;
  try {
    target = new URL(loopback);
  } catch {
    return null;
  }
  const local = new Set([`127.0.0.1:${target.port}`, `localhost:${target.port}`]);
  for (const [hostPort, site] of Object.entries(status.Web ?? {})) {
    const proxy = site.Handlers?.["/"]?.Proxy;
    if (!proxy) continue;
    let proxied: URL;
    try {
      proxied = new URL(proxy);
    } catch {
      continue;
    }
    if (local.has(proxied.host)) return `https://${hostPort.replace(/:443$/u, "")}`;
  }
  return null;
}

export async function tailscaleServeOrigin(loopback: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["serve", "status", "--json"], {
      timeout: 5000,
    });
    return originFromServeStatus(JSON.parse(stdout) as ServeStatus, loopback);
  } catch {
    return null;
  }
}

export function threadUrl(base: string, projectId: string, threadId: string): string {
  return `${base.replace(/\/+$/u, "")}/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}`;
}
