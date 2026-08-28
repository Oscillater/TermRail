const authToken = (import.meta.env.VITE_AUTH_TOKEN ?? "").trim();

export function apiHeaders(): HeadersInit {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

export function jsonHeaders(): HeadersInit {
  return {
    ...apiHeaders(),
    "Content-Type": "application/json",
  };
}

export function wsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${window.location.host}/ws`);
  if (authToken) {
    url.searchParams.set("token", authToken);
  }
  return url.toString();
}

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...apiHeaders(),
      ...options.headers,
    },
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as {
        error?: { message?: string; code?: string };
      };
      message = body.error?.message ?? body.error?.code ?? message;
    } catch {
      // Keep the HTTP status fallback when the server did not return JSON.
    }
    throw new Error(message);
  }

  return response;
}

export async function jsonRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await request(path, options);
  return (await response.json()) as T;
}

export async function textRequest(
  path: string,
  options: RequestInit = {},
): Promise<string> {
  const response = await request(path, options);
  return await response.text();
}

export async function voidRequest(
  path: string,
  options: RequestInit = {},
): Promise<void> {
  await request(path, options);
}
