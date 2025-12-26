import * as dnsPacket from 'dns-packet';
import { Buffer } from 'buffer';
import { Env, UPSTREAM_RESOLVERS } from '../types';

export async function handleDoH(request: Request, env: Env, corsHeaders: any, provider: string = 'google'): Promise<Response> {
  if (request.method !== 'POST') return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  try {
    const buf = await request.arrayBuffer();
    const query = dnsPacket.decode(Buffer.from(buf));
    const question = query.questions?.[0];

    if (!question) return new Response("Invalid Query", { status: 400, headers: corsHeaders });

    const parts = question.name.toLowerCase().split('.');
    const tld = parts[parts.length - 1];

    // ---------------------------------------------------------
    // 1. プロキシ判定 (管理外TLDは外部へ)
    // ---------------------------------------------------------
    const tldRecord = await env.DB.prepare("SELECT 1 FROM tlds WHERE name=?").bind(tld).first();
    const isSystemTld = env.CUSTOM_TLDS.split(',').includes(tld);

    if (!tldRecord && !isSystemTld) {
      const upstreamUrl = UPSTREAM_RESOLVERS[provider] || UPSTREAM_RESOLVERS.google;
      const resp = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/dns-message' },
        body: buf
      });
      return new Response(resp.body, { status: resp.status, headers: { ...corsHeaders, "Content-Type": "application/dns-message" } });
    }

    // ---------------------------------------------------------
    // 2. 自社解決ロジック
    // ---------------------------------------------------------
    const domainName = parts[parts.length - 2];
    if (!domainName) return new Response("NXDOMAIN", { status: 404 });

    const hostParts = parts.slice(0, parts.length - 2);
    const host = hostParts.length > 0 ? hostParts.join('.') : '@';

    const domainRecord = await env.DB.prepare("SELECT id FROM domains WHERE tld=? AND name=?").bind(tld, domainName).first();
    
    let answers: any[] = [];

    if (domainRecord) {
      // 該当するレコードを取得
      const { results } = await env.DB.prepare(
        "SELECT type, value, priority, ttl FROM records WHERE domain_id=? AND (host=? OR host='*')"
      ).bind(domainRecord.id, host).all();

      answers = results
        // @ts-ignore: D1の結果型定義回避
        .filter(r => r.type === question.type || (question.type as string) === 'ANY' || r.type === 'CNAME')
        .map(r => {
          // 型アサーションを使ってTypeScriptエラーを回避
          const recordType = r.type as string;
          const recordValue = r.value as string;
          const recordPriority = r.priority as number;
          const recordTtl = r.ttl as number;

          // 全55種対応フォーマッターへ渡す
          const data = formatRecordData(recordType, recordValue, recordPriority);
          
          return {
            type: recordType as any,
            class: 'IN',
            name: question.name,
            data: data,
            ttl: recordTtl || 300
          };
        });
    }

    const responsePacket = dnsPacket.encode({
      type: 'response',
      id: query.id,
      flags: dnsPacket.AUTHORITATIVE_ANSWER,
      questions: query.questions,
      answers: answers
    });

    return new Response(responsePacket, {
      headers: { ...corsHeaders, "Content-Type": "application/dns-message" }
    });

  } catch (e) {
    console.error("DoH Error:", e);
    return new Response("Server Error", { status: 500, headers: corsHeaders });
  }
}

/**
 * 全55種のレコードタイプに応じてDBの値を整形する完全版関数
 */
function formatRecordData(type: string, value: string, priority?: number): any {
  // JSONパースを試みる (構造化データ用)
  let parsed: any = value;
  try {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      parsed = JSON.parse(trimmed);
    }
  } catch (e) { /* 文字列のまま */ }

  const t = type.toUpperCase();

  switch (t) {
    // --- Basic Strings / IP ---
    case 'A':
    case 'AAAA':
    case 'CNAME':
    case 'NS':
    case 'PTR':
    case 'DNAME':
      return value;

    // --- Text / Arrays ---
    case 'TXT':
    case 'SPF':
    case 'AVC':
    case 'NINFO':
      // dns-packetは配列、または文字列を受け付ける
      return Array.isArray(parsed) ? parsed : [value];

    // --- Priority Based ---
    case 'MX':
      // { preference, exchange }
      if (typeof parsed === 'object' && parsed.exchange) return parsed;
      return { preference: priority || 10, exchange: value };
    
    case 'URI':
      // { priority, weight, target }
      if (typeof parsed === 'object' && parsed.target) return parsed;
      return { priority: priority || 10, weight: 1, target: value };

    case 'KX':
      // { preference, exchange }
      if (typeof parsed === 'object' && parsed.exchange) return parsed;
      return { preference: priority || 10, exchange: value };

    case 'PX':
      // { preference, map822, mapx400 }
      return typeof parsed === 'object' ? parsed : { preference: priority||0, map822:'', mapx400:'' };

    // --- Complex Structures (Must be JSON) ---
    case 'SRV':
      // { priority, weight, port, target }
      if (typeof parsed === 'object') {
        if (parsed.priority === undefined) parsed.priority = priority || 0;
        return parsed;
      }
      return { priority: priority||0, weight:0, port:0, target:value };
    
    case 'SOA':
      // { mname, rname, serial, refresh, retry, expire, minimum }
      return typeof parsed === 'object' ? parsed : {};

    case 'HTTPS':
    case 'SVCB':
      // { priority, target, value: { alpn, ... } }
      if (typeof parsed === 'object') {
        if (parsed.priority === undefined && priority !== undefined) parsed.priority = priority;
        return parsed;
      }
      return { priority: priority || 1, target: '.', value: {} };

    case 'NAPTR':
      // { order, preference, flags, services, regexp, replacement }
      return typeof parsed === 'object' ? parsed : {};

    case 'CAA':
      // { issuer, tag, value, flags }
      return typeof parsed === 'object' ? parsed : { flags:0, tag:'issue', value: value };

    case 'HINFO':
      // { cpu, os }
      return typeof parsed === 'object' ? parsed : { cpu: 'INTEL-386', os: 'UNIX' };

    case 'LOC':
      // { size, horizPre, vertPre, latitude, longitude, altitude }
      return typeof parsed === 'object' ? parsed : {};

    case 'GPOS':
      // { longitude, latitude, altitude }
      return typeof parsed === 'object' ? parsed : {};

    case 'RP':
      // { mbox, txt }
      return typeof parsed === 'object' ? parsed : {};

    case 'AFSDB':
      // { subtype, hostname }
      return typeof parsed === 'object' ? parsed : {};

    case 'RT':
      // { preference, intermediateHost }
      return typeof parsed === 'object' ? parsed : { preference: priority||0, intermediateHost: value };

    // --- DNSSEC / Crypto / Binary Types ---
    // これらは通常、Hex文字列やBuffer、または構造化オブジェクトとして扱われます
    case 'DS':        // { keyTag, algorithm, digestType, digest }
    case 'DNSKEY':    // { flags, algorithm, key }
    case 'RRSIG':     // { typeCovered, algorithm, labels, originalTTL, expiration, inception, keyTag, signersName, signature }
    case 'NSEC':      // { nextDomain, rrtypes }
    case 'NSEC3':     // { algorithm, flags, iterations, salt, nextDomain, rrtypes }
    case 'NSEC3PARAM':// { algorithm, flags, iterations, salt }
    case 'DLV':       // (Same as DS)
    case 'CDS':       // (Same as DS)
    case 'CDNSKEY':   // (Same as DNSKEY)
    case 'TA':        // (Same as DS)
    case 'KEY':       // (Same as DNSKEY)
    case 'TLSA':      // { usage, selector, matchingType, certificate }
    case 'SMIMEA':    // (Same as TLSA)
    case 'CERT':      // { type, keyTag, algorithm, certificate }
    case 'SSHFP':     // { algorithm, hash, fingerprint }
    case 'IPSECKEY':  // { precedence, gatewayType, algorithm, gateway, publicKey }
    case 'TKEY':      // { algorithm, inception, expiration, mode, error, key, otherData }
    case 'TSIG':      // { algorithm, timeSigned, fudge, mac, originalId, error, otherData }
    case 'SIG':       // (Same as RRSIG)
    case 'RKEY':      // { flags, protocol, algorithm, publicKey }
    case 'HIP':       // { hit, pkAlgorithm, pk, rendezvousServers }
    case 'CSYNC':     // { serial, flags, types }
    case 'ZONEMD':    // { serial, scheme, hashAlg, digest }
    case 'TALINK':    // { previous, next }
    case 'AMTRELAY':  // { precedence, discoveryOptional, type, relay }
      return typeof parsed === 'object' ? parsed : {};

    // --- Other / Obsolete / Binary Blobs ---
    case 'DHCID':
    case 'EID':
    case 'NIMLOC':
    case 'ATMA':
    case 'APL':       // { prefixes: [...] }
    case 'EUI48':
    case 'EUI64':
    case 'OPENPGPKEY':
      // JSONパース済みならそれを返す、そうでなければ文字列/Bufferとして返す
      return parsed;

    // --- Default Fallback ---
    default:
      return value;
  }
}