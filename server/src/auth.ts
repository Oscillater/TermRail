import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { RequestHandler } from "express";

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function extractBearer(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1]?.trim() ?? null;
}

function extractToken(request: IncomingMessage): string | null {
  const authHeader = headerValue(request.headers.authorization);
  const bearer = extractBearer(authHeader);
  if (bearer) {
    return bearer;
  }

  const tokenHeader = headerValue(request.headers["x-auth-token"]);
  if (tokenHeader) {
    return tokenHeader.trim();
  }

  if (request.url) {
    const url = new URL(request.url, "http://127.0.0.1");
    return url.searchParams.get("token");
  }

  return null;
}

function matchesToken(candidate: string | null, expected: string): boolean {
  if (!candidate) {
    return false;
  }

  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isAuthorized(
  request: IncomingMessage,
  authToken: string,
): boolean {
  if (!authToken) {
    return true;
  }
  return matchesToken(extractToken(request), authToken);
}

export function authMiddleware(authToken: string): RequestHandler {
  return (request, response, next) => {
    if (isAuthorized(request, authToken)) {
      next();
      return;
    }

    response.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Auth token is required",
      },
    });
  };
}
