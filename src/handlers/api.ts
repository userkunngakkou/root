import { Env } from '../types';

// 🚫 登録禁止リスト (ICANN TLDs & Reserved Words)
// これらはユーザーが勝手にRoot TLDとして登録できないように保護します
const RESERVED_ICANN_TLDS = new Set([
  // gTLDs (Generic)
  'com', 'net', 'org', 'info', 'biz', 'xyz', 'online', 'site', 'top', 'tech', 'shop', 'store', 'club', 'vip',
  'app', 'dev', 'pro', 'io', 'co', 'me', 'tv', 'cc', 'mobi', 'name', 'aero', 'asia', 'cat', 'jobs', 'tel',
  'travel', 'xxx', 'edu', 'gov', 'mil', 'int', 'arpa', 'museum', 'coop',
  // ccTLDs (Country Code - Major ones)
  'jp', 'us', 'uk', 'cn', 'de', 'ru', 'br', 'fr', 'au', 'ca', 'in', 'it', 'nl', 'es', 'se', 'ch', 'kr', 'tw',
  'vn', 'id', 'my', 'ph', 'sg', 'th', 'ae', 'sa', 'za', 'ng', 'eg', 'mx', 'ar', 'cl', 'pe', 'co', 've',
  'eu', 'be', 'at', 'dk', 'no', 'fi', 'pl', 'cz', 'hu', 'ro', 'gr', 'pt', 'ie', 'nz', 'hk',
  // Reserved / Special
  'example', 'test', 'localhost', 'invalid', 'local', 'onion', 'internal', 'lan', 'home', 'corp'
]);

export async function handleApi(url: URL, request: Request, env: Env, corsHeaders: any): Promise<Response> {
  const path = url.pathname;

  // JSONレスポンス生成ヘルパー
  const json = (data: any, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });

  // エラーレスポンス生成ヘルパー
  const err = (msg: string, status = 400) => json({ error: msg }, status);

  try {
    // ==========================================
    // 1. Registry API (Root TLD管理)
    // ==========================================

    // [GET] /api/tlds
    // 全ての登録済みTLDと、システム予約TLDの一覧を返します
    if (path === "/api/tlds") {
      const { results } = await env.DB.prepare(
        "SELECT name, owner_id, is_public, price FROM tlds"
      ).all();

      // 環境変数(wrangler.jsonc)で定義されたシステムTLDを取得
      const envTlds = env.CUSTOM_TLDS ? env.CUSTOM_TLDS.split(',') : [];
      
      const dbTlds = results || [];
      const allTlds = [...dbTlds];

      // システムTLDがDBにない場合、リストに追加して表示する
      envTlds.forEach(t => {
        const trimmedTld = t.trim();
        if (trimmedTld && !dbTlds.find((dt: any) => dt.name === trimmedTld)) {
          allTlds.push({
            name: trimmedTld,
            is_public: 1,
            price: 0,
            owner_id: 'SYSTEM'
          });
        }
      });

      return json(allTlds);
    }

    // [POST] /api/tld/register
    // 新しいRoot TLDを登録します (早い者勝ち & ICANN保護)
    if (path === "/api/tld/register" && request.method === "POST") {
      const body = await request.json() as any;
      const name = body.name;
      const ownerId = body.owner_id;

      // バリデーション
      if (!name || typeof name !== 'string') return err("Invalid TLD name.");
      const lowerName = name.toLowerCase().trim();

      if (lowerName.includes('.')) return err("Root TLD cannot contain dots.");
      if (lowerName.length < 2) return err("TLD is too short (min 2 chars).");
      if (lowerName.length > 63) return err("TLD is too long (max 63 chars).");

      // ★ ICANN / 予約語チェック
      if (RESERVED_ICANN_TLDS.has(lowerName)) {
        return err(`'.${lowerName}' is reserved by ICANN/IANA and cannot be registered.`);
      }

      // 重複チェック (DB)
      const exists = await env.DB.prepare("SELECT 1 FROM tlds WHERE name=?").bind(lowerName).first();
      // 重複チェック (システム予約)
      const isSystem = env.CUSTOM_TLDS.split(',').includes(lowerName);

      if (exists || isSystem) {
        return err(`TLD '.${lowerName}' is already taken.`);
      }

      // 登録実行
      await env.DB.prepare(
        "INSERT INTO tlds (name, owner_id, is_public, price, created_at, config) VALUES (?, ?, 0, 0, ?, '{}')"
      ).bind(lowerName, ownerId, Date.now()).run();

      return json({ success: true, message: `.${lowerName} registered successfully.` });
    }

    // [POST] /api/tld/update
    // TLDの設定（公開/非公開、価格など）を更新します
    if (path === "/api/tld/update" && request.method === "POST") {
      const body = await request.json() as any;
      const { name, owner_id, is_public, price, config } = body;

      // 所有権チェック
      const tld = await env.DB.prepare("SELECT owner_id FROM tlds WHERE name=?").bind(name).first();
      // @ts-ignore
      if (!tld || tld.owner_id !== owner_id) {
        return err("Unauthorized: You do not own this TLD.", 403);
      }

      // 更新実行
      await env.DB.prepare(
        "UPDATE tlds SET is_public=?, price=?, config=? WHERE name=?"
      ).bind(
        is_public ? 1 : 0,
        Number(price) || 0,
        JSON.stringify(config || {}),
        name
      ).run();

      return json({ success: true });
    }

    // ==========================================
    // 2. Registrar API (ドメイン管理)
    // ==========================================

    // [GET] /api/domain/check
    // 特定のTLD配下のドメインが空いているか確認します
    if (path === "/api/domain/check") {
      const name = url.searchParams.get("name");
      const tldName = url.searchParams.get("tld");

      if (!name || !tldName) return err("Missing name or tld parameters.");

      // TLD情報の取得 (公開設定と価格)
      const tldDb = await env.DB.prepare("SELECT is_public, price FROM tlds WHERE name=?").bind(tldName).first();
      const tldEnv = env.CUSTOM_TLDS.split(',').includes(tldName);

      if (!tldDb && !tldEnv) {
        return json({ status: "tld_not_found" });
      }

      // デフォルト値 (System TLDの場合)
      // @ts-ignore
      const price = tldDb ? tldDb.price : 0;
      // @ts-ignore
      const isPublic = tldDb ? tldDb.is_public : 1;

      // TLDが非公開なら登録不可
      if (!isPublic) {
        return json({ status: "private" });
      }

      // ドメイン名の重複チェック
      const exists = await env.DB.prepare("SELECT 1 FROM domains WHERE tld=? AND name=?").bind(tldName, name).first();
      
      return json({ 
        status: exists ? "taken" : "available", 
        price: price 
      });
    }

    // [POST] /api/domain/register
    // ドメインを実際に登録します
    if (path === "/api/domain/register" && request.method === "POST") {
      const body = await request.json() as any;
      const { name, tld, owner_id } = body;

      if (!name || !tld || !owner_id) return err("Missing required fields.");

      // 最終重複チェック
      const check = await env.DB.prepare("SELECT 1 FROM domains WHERE tld=? AND name=?").bind(tld, name).first();
      if (check) return err("Domain is already taken.");

      // ドメイン作成
      const res = await env.DB.prepare(
        "INSERT INTO domains (tld, name, owner_id, created_at) VALUES (?, ?, ?, ?) RETURNING id"
      ).bind(tld, name, owner_id, Date.now()).first();

      if (!res) return err("Failed to create domain.", 500);

      // 初期DNSレコード (Aレコード) を自動作成
      // @ts-ignore
      const domainId = res.id;
      await env.DB.prepare(
        "INSERT INTO records (domain_id, type, host, value, priority, ttl) VALUES (?, 'A', '@', '127.0.0.1', 0, 300)"
      ).bind(domainId).run();

      return json({ success: true });
    }

    // [GET] /api/dashboard
    // ユーザーが所有するTLDとドメインの一覧を一括取得します
    if (path === "/api/dashboard") {
      const ownerId = url.searchParams.get("owner_id");
      if (!ownerId) return err("Missing owner_id parameter.");

      const myTlds = await env.DB.prepare(
        "SELECT name, is_public, price, created_at FROM tlds WHERE owner_id=? ORDER BY created_at DESC"
      ).bind(ownerId).all();

      const myDomains = await env.DB.prepare(
        "SELECT id, tld, name, created_at FROM domains WHERE owner_id=? ORDER BY created_at DESC"
      ).bind(ownerId).all();

      return json({
        tlds: myTlds.results,
        domains: myDomains.results
      });
    }

    // ==========================================
    // 3. DNS Record API (レコード管理)
    // ==========================================

    // [GET] /api/records
    // 特定ドメインのレコード一覧を取得します
    if (path === "/api/records") {
      const domainId = url.searchParams.get("domain_id");
      if (!domainId) return err("Missing domain_id parameter.");

      const { results } = await env.DB.prepare(
        "SELECT * FROM records WHERE domain_id=?"
      ).bind(domainId).all();

      return json(results);
    }

    // [POST] /api/records/update
    // レコードの一括更新 (全削除 -> 再挿入 のトランザクション的処理)
    if (path === "/api/records/update" && request.method === "POST") {
      const body = await request.json() as any;
      const { domain_id, owner_id, records } = body;

      if (!domain_id || !owner_id) return err("Missing required fields.");

      // ドメイン所有権の確認
      const domain = await env.DB.prepare("SELECT owner_id FROM domains WHERE id=?").bind(domain_id).first();
      // @ts-ignore
      if (!domain || domain.owner_id !== owner_id) {
        return err("Unauthorized: You do not own this domain.", 403);
      }

      // バッチ処理の準備
      const batch = [];

      // 1. 既存レコードを全て削除
      batch.push(env.DB.prepare("DELETE FROM records WHERE domain_id=?").bind(domain_id));

      // 2. 新しいレコードを挿入
      if (Array.isArray(records)) {
        for (const r of records) {
          let valToStore = r.value;

          // 複雑なレコードタイプ(オブジェクト)の場合はJSON文字列に変換して保存
          // 対応: MX, SRV, HTTPS, SVCB, SOA, NAPTR, TLSA, SSHFP etc...
          if (typeof r.value === 'object' && r.value !== null) {
            valToStore = JSON.stringify(r.value);
          } else {
            // 文字列なら文字列として確実に保存
            valToStore = String(r.value);
          }

          // 空の値は保存しない (ゴミデータ防止)
          if (valToStore && valToStore.trim() !== "") {
            batch.push(
              env.DB.prepare(
                "INSERT INTO records (domain_id, type, host, value, priority, ttl) VALUES (?, ?, ?, ?, ?, ?)"
              ).bind(
                domain_id,
                r.type || 'A',
                r.host || '@',
                valToStore,
                Number(r.priority) || 0,
                Number(r.ttl) || 300
              )
            );
          }
        }
      }

      // 一括実行
      await env.DB.batch(batch);

      return json({ success: true, message: "DNS records updated successfully." });
    }

  } catch (e: any) {
    // サーバー内部エラーのハンドリング
    console.error("API Error:", e);
    return err(e.message || "Internal Server Error", 500);
  }

  // エンドポイントが見つからない場合
  return new Response("API Endpoint Not Found", { status: 404, headers: corsHeaders });
}