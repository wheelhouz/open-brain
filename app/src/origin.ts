import { config } from "./config.js";

interface OriginRequest {
  header: (name: string) => string | undefined;
  url: string;
}

function firstHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  if (!first) return undefined;
  return first.replace(/^"|"$/g, "");
}

function forwardedParam(header: string | undefined, name: string): string | undefined {
  const first = firstHeaderValue(header);
  if (!first) return undefined;

  for (const part of first.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey?.toLowerCase() !== name) continue;
    const value = rawValue.join("=").trim();
    return value.replace(/^"|"$/g, "") || undefined;
  }

  return undefined;
}

function hostnameFromHost(host: string): string {
  const bracketEnd = host.startsWith("[") ? host.indexOf("]") : -1;
  if (bracketEnd > 0) return host.slice(1, bracketEnd).toLowerCase();
  return host.split(":")[0]?.toLowerCase() || host.toLowerCase();
}

function defaultProtoForHost(host: string): "http" | "https" {
  const hostname = hostnameFromHost(host);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  ) {
    return "http";
  }
  return "https";
}

function normalizeProto(proto: string | undefined, host: string): "http" | "https" {
  const normalized = proto?.replace(/:$/, "").toLowerCase();
  if (normalized === "http" || normalized === "https") return normalized;
  return defaultProtoForHost(host);
}

export function getPublicOrigin(req: OriginRequest): string {
  if (config.publicOrigin) return config.publicOrigin;

  const forwarded = req.header("forwarded");
  const host =
    firstHeaderValue(req.header("x-forwarded-host")) ||
    forwardedParam(forwarded, "host") ||
    firstHeaderValue(req.header("host")) ||
    new URL(req.url).host;
  const proto = normalizeProto(
    firstHeaderValue(req.header("x-forwarded-proto")) ||
      forwardedParam(forwarded, "proto"),
    host,
  );

  return `${proto}://${host}`;
}
