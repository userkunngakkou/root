import * as dnsPacket from 'dns-packet';
import { Buffer } from 'buffer'; // ← "node:buffer" ではなく "buffer" を使用

import { Env, UPSTREAM_RESOLVERS } from '../types';

export async function handleDoH(request: Request, env: Env, corsHeaders: any, provider: string = 'google'): Promise<Response> {
  if (request.method !== 'POST') return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  try {
    const buf = await request.arrayBuffer();
    // npmのBufferを使って変換
    const query = dnsPacket.decode(Buffer.from(buf));
    const question = query.questions?.[0];

    if (!question) return new Response("Invalid Query", { status: 400, headers: corsHeaders });

    const parts = question.name.toLowerCase().split('.');
    const tld = parts[parts.length - 1];

    const tldRecord = await env.DB.prepare("SELECT 1 FROM tlds WHERE name=?").bind(tld).first();
    const isSystemTld = env.CUSTOM_TLDS.split(',').includes(tld);

    if (!tldRecord && !isSystemTld) {
      const upstreamUrl = UPSTREAM_RESOLVERS[provider] || UPSTREAM_RESOLVERS.google;
      const resp = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/dns-message' },
        body: buf
      });
      return new Response(resp.body, {
        status: resp.status,
        headers: { ...corsHeaders, "Content-Type": "application/dns-message" }
      });
    }

    const domainName = parts[parts.length - 2]; 
    if (!domainName) return new Response("NXDOMAIN", { status: 404 });

    const hostParts = parts.slice(0, parts.length - 2);
    const host = hostParts.length > 0 ? hostParts.join('.') : '@';

    const domainRecord = await env.DB.prepare("SELECT id FROM domains WHERE tld=? AND name=?").bind(tld, domainName).first();
    
    let answers: any[] = [];

    if (domainRecord) {
      const { results } = await env.DB.prepare(
        "SELECT type, value, priority, ttl FROM records WHERE domain_id=? AND (host=? OR host='*')"
      ).bind(domainRecord.id, host).all();

      answers = results
        .filter(r => r.type === question.type || (question.type as string) === 'ANY' || question.type === 'CNAME')
        .map(r => {
          let data: any = r.value;
          if (r.type === 'MX') data = { preference: r.priority || 10, exchange: r.value };
          if (r.type === 'TXT') data = [r.value];
          
          return {
            type: r.type as any,
            class: 'IN',
            name: question.name,
            data: data,
            ttl: r.ttl || 300
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
    return new Response("Server Error", { status: 500, headers: corsHeaders });
  }
}