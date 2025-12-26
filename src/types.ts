export interface Env {
  DB: D1Database;
  CUSTOM_TLDS: string;
}

export interface DnsRecord {
  id?: number;
  type: string;
  host: string;
  value: string;
  priority?: number;
  ttl?: number;
}

export const UPSTREAM_RESOLVERS: Record<string, string> = {
  google: "https://8.8.8.8/dns-query",
  cf: "https://1.1.1.1/dns-query",
  quad9: "https://9.9.9.9/dns-query",
};