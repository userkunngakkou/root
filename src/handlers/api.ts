import { Env } from '../types';

export async function handleApi(url: URL, request: Request, env: Env, corsHeaders: any): Promise<Response> {
  const path = url.pathname;
  const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const err = (msg: string, status = 400) => json({ error: msg }, status);

  try {
    // --- TLD関連 ---
    if (path === "/api/tlds") {
      const { results } = await env.DB.prepare("SELECT name, owner_id, is_public, price FROM tlds").all();
      const envTlds = env.CUSTOM_TLDS ? env.CUSTOM_TLDS.split(',') : [];
      const dbTlds = results || [];
      const allTlds = [...dbTlds];
      envTlds.forEach(t => {
        if (!dbTlds.find((dt:any) => dt.name === t)) {
          allTlds.push({ name: t, is_public: 1, price: 0, owner_id: 'SYSTEM' });
        }
      });
      return json(allTlds);
    }

    if (path === "/api/tld/register" && request.method === "POST") {
      const { name, owner_id } = await request.json() as any;
      if (!name || name.includes('.')) return err("Invalid TLD format");
      const exists = await env.DB.prepare("SELECT 1 FROM tlds WHERE name=?").bind(name).first();
      const isSystem = env.CUSTOM_TLDS.split(',').includes(name);
      if (exists || isSystem) return err("TLD is already taken");

      await env.DB.prepare("INSERT INTO tlds (name, owner_id, is_public, price, created_at, config) VALUES (?, ?, 0, 0, ?, '{}')")
        .bind(name, owner_id, Date.now()).run();
      return json({ success: true });
    }

    if (path === "/api/tld/update" && request.method === "POST") {
      const { name, owner_id, is_public, price, config } = await request.json() as any;
      const tld = await env.DB.prepare("SELECT owner_id FROM tlds WHERE name=?").bind(name).first();
      // @ts-ignore
      if (!tld || tld.owner_id !== owner_id) return err("Unauthorized", 403);

      await env.DB.prepare("UPDATE tlds SET is_public=?, price=?, config=? WHERE name=?")
        .bind(is_public ? 1 : 0, Number(price) || 0, JSON.stringify(config || {}), name).run();
      return json({ success: true });
    }

    // --- ドメイン関連 ---
    if (path === "/api/domain/check") {
      const name = url.searchParams.get("name");
      const tldName = url.searchParams.get("tld");
      const tldDb = await env.DB.prepare("SELECT is_public, price FROM tlds WHERE name=?").bind(tldName).first();
      const tldEnv = env.CUSTOM_TLDS.split(',').includes(tldName!);
      
      if (!tldDb && !tldEnv) return json({ status: "tld_not_found" });
      // @ts-ignore
      const price = tldDb ? tldDb.price : 0;
      // @ts-ignore
      const isPublic = tldDb ? tldDb.is_public : 1;

      if (!isPublic) return json({ status: "private" });

      const exists = await env.DB.prepare("SELECT 1 FROM domains WHERE tld=? AND name=?").bind(tldName, name).first();
      return json({ status: exists ? "taken" : "available", price });
    }

    if (path === "/api/domain/register" && request.method === "POST") {
      const { name, tld, owner_id } = await request.json() as any;
      const check = await env.DB.prepare("SELECT 1 FROM domains WHERE tld=? AND name=?").bind(tld, name).first();
      if (check) return err("Domain already taken");

      const res = await env.DB.prepare("INSERT INTO domains (tld, name, owner_id, created_at) VALUES (?, ?, ?, ?) RETURNING id")
        .bind(tld, name, owner_id, Date.now()).first();
      // @ts-ignore
      await env.DB.prepare("INSERT INTO records (domain_id, type, host, value) VALUES (?, 'A', '@', '127.0.0.1')").bind(res.id).run();
      return json({ success: true });
    }

    if (path === "/api/dashboard") {
      const owner_id = url.searchParams.get("owner_id");
      const myTlds = await env.DB.prepare("SELECT name, is_public, price FROM tlds WHERE owner_id=?").bind(owner_id).all();
      const myDomains = await env.DB.prepare("SELECT id, tld, name FROM domains WHERE owner_id=?").bind(owner_id).all();
      return json({ tlds: myTlds.results, domains: myDomains.results });
    }

    // --- レコード関連 ---
    if (path === "/api/records") {
      const domainId = url.searchParams.get("domain_id");
      const { results } = await env.DB.prepare("SELECT * FROM records WHERE domain_id=?").bind(domainId).all();
      return json(results);
    }

    if (path === "/api/records/update" && request.method === "POST") {
      const { domain_id, owner_id, records } = await request.json() as any;
      const domain = await env.DB.prepare("SELECT owner_id FROM domains WHERE id=?").bind(domain_id).first();
      // @ts-ignore
      if (!domain || domain.owner_id !== owner_id) return err("Unauthorized", 403);

      const batch = [env.DB.prepare("DELETE FROM records WHERE domain_id=?").bind(domain_id)];
      if (Array.isArray(records)) {
        for (const r of records) {
          if (r.value && r.value.trim() !== "") {
            batch.push(
              env.DB.prepare("INSERT INTO records (domain_id, type, host, value, priority, ttl) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(domain_id, r.type, r.host || '@', r.value, r.priority || 0, r.ttl || 300)
            );
          }
        }
      }
      await env.DB.batch(batch);
      return json({ success: true });
    }

  } catch (e: any) {
    return err(e.message, 500);
  }
  return new Response("API Endpoint Not Found", { status: 404, headers: corsHeaders });
}