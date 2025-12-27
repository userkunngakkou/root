import { Env } from '../types';
import { jsonResponse, errorResponse } from '../utils';

// ★ ローカルのJSONファイルからICANNリストを読み込み (高速化 & コード短縮)
// ※ src/handlers/tlds.json が存在することを前提としています
import icannTlds from './tlds.json';
const RESERVED_ICANN_TLDS = new Set(icannTlds);

export async function handleApi(url: URL, request: Request, env: Env, corsHeaders: any): Promise<Response> {
  const path = url.pathname;

  try {
    // =================================================================================
    // 1. Registry API (Root TLD Management)
    // =================================================================================

    /**
     * [GET] /api/tlds
     * 登録されている全てのTLDと、システム予約TLD（wrangler.jsoncで指定）をマージして返します。
     * フロントエンドのマーケットプレイスや検索でのサジェストに使用されます。
     */
    if (path === "/api/tlds") {
      const { results } = await env.DB.prepare(
        "SELECT name, owner_id, is_public, price FROM tlds"
      ).all();

      const envTlds = env.CUSTOM_TLDS ? env.CUSTOM_TLDS.split(',') : [];
      const dbTlds = results || [];
      const allTlds = [...dbTlds];

      // システムTLD (環境変数定義) がDBにない場合、表示用リストに追加
      envTlds.forEach(t => {
        const trimmedTld = t.trim();
        if (trimmedTld && !dbTlds.find((dt: any) => dt.name === trimmedTld)) {
          allTlds.push({
            name: trimmedTld,
            is_public: 1, // システムTLDはデフォルト公開
            price: 0,     // システムTLDはデフォルト無料
            owner_id: 'SYSTEM'
          });
        }
      });

      return jsonResponse(allTlds, 200, corsHeaders);
    }

    /**
     * [POST] /api/tld/register
     * 新しいRoot TLDを登録します。
     * - フォーマットチェック
     * - ICANN予約語チェック (tlds.json参照)
     * - ユーザーごとのTLD所有上限チェック
     */
    if (path === "/api/tld/register" && request.method === "POST") {
      const body = await request.json() as any;
      const { name, owner_id } = body;

      if (!name || typeof name !== 'string') return errorResponse("Invalid TLD name.", 400, corsHeaders);
      if (!owner_id) return errorResponse("Authentication required.", 401, corsHeaders);

      const lowerName = name.toLowerCase().trim();

      // 基本的なフォーマット検証
      if (lowerName.includes('.')) return errorResponse("Root TLD cannot contain dots.", 400, corsHeaders);
      if (lowerName.length < 2) return errorResponse("TLD is too short (min 2 chars).", 400, corsHeaders);
      if (lowerName.length > 63) return errorResponse("TLD is too long (max 63 chars).", 400, corsHeaders);
      if (!/^[a-z0-9-]+$/.test(lowerName)) return errorResponse("TLD contains invalid characters.", 400, corsHeaders);

      // ★ ICANN / 予約語チェック
      if (RESERVED_ICANN_TLDS.has(lowerName)) {
        return errorResponse(`'.${lowerName}' is reserved by ICANN/IANA and cannot be registered.`, 403, corsHeaders);
      }

      // ユーザー情報の取得 (上限チェック用)
      const user = await env.DB.prepare("SELECT tld_limit FROM users WHERE id = ?").bind(owner_id).first() as { tld_limit: number } | null;
      if (!user) {
        return errorResponse("User not found. Please login again.", 401, corsHeaders);
      }

      // 現在のTLD所有数を確認
      const countRes = await env.DB.prepare("SELECT COUNT(*) as count FROM tlds WHERE owner_id = ?").bind(owner_id).first() as { count: number } | null;
      const currentCount = countRes?.count || 0;
      const limit = user.tld_limit || 10; // デフォルト上限は10個

      if (currentCount >= limit) {
        return errorResponse(`TLD Limit Reached. You can only own ${limit} TLDs on your current plan.`, 403, corsHeaders);
      }

      // TLDの重複チェック (DB内)
      const exists = await env.DB.prepare("SELECT 1 FROM tlds WHERE name=?").bind(lowerName).first();
      // TLDの重複チェック (システム予約内)
      const isSystem = env.CUSTOM_TLDS.split(',').includes(lowerName);

      if (exists || isSystem) {
        return errorResponse(`TLD '.${lowerName}' is already taken.`, 409, corsHeaders);
      }

      // 登録実行
      await env.DB.prepare(
        "INSERT INTO tlds (name, owner_id, is_public, price, created_at, config) VALUES (?, ?, 0, 0, ?, '{}')"
      ).bind(lowerName, owner_id, Date.now()).run();

      return jsonResponse({ success: true, message: `.${lowerName} has been successfully registered.` }, 200, corsHeaders);
    }

    /**
     * [POST] /api/tld/update
     * TLDの設定（公開/非公開、価格、Config）を更新します。
     */
    if (path === "/api/tld/update" && request.method === "POST") {
      const body = await request.json() as any;
      const { name, owner_id, is_public, price, config } = body;

      if (!name || !owner_id) return errorResponse("Missing required fields.", 400, corsHeaders);

      // 所有権チェック
      const tld = await env.DB.prepare("SELECT owner_id FROM tlds WHERE name=?").bind(name).first() as { owner_id: string } | null;
      
      if (!tld) return errorResponse("TLD not found.", 404, corsHeaders);
      if (tld.owner_id !== owner_id) return errorResponse("Unauthorized: You do not own this TLD.", 403, corsHeaders);

      // 更新実行
      await env.DB.prepare(
        "UPDATE tlds SET is_public=?, price=?, config=? WHERE name=?"
      ).bind(
        is_public ? 1 : 0,
        Number(price) || 0,
        JSON.stringify(config || {}),
        name
      ).run();

      return jsonResponse({ success: true, message: "TLD settings updated." }, 200, corsHeaders);
    }

    /**
     * [DELETE] /api/tld/delete
     * TLDを削除します。関連するドメインとレコードもカスケード削除されます。
     */
    if (path === "/api/tld/delete" && request.method === "DELETE") {
      const body = await request.json() as any;
      const { name, owner_id } = body;

      const tld = await env.DB.prepare("SELECT owner_id FROM tlds WHERE name=?").bind(name).first() as { owner_id: string } | null;
      if (!tld || tld.owner_id !== owner_id) return errorResponse("Unauthorized or Not Found.", 403, corsHeaders);

      // 削除バッチ処理 (Record -> Domain -> TLD)
      await env.DB.batch([
        env.DB.prepare("DELETE FROM records WHERE domain_id IN (SELECT id FROM domains WHERE tld=?)").bind(name),
        env.DB.prepare("DELETE FROM domains WHERE tld=?").bind(name),
        env.DB.prepare("DELETE FROM tlds WHERE name=?").bind(name)
      ]);

      return jsonResponse({ success: true, message: `TLD .${name} deleted.` }, 200, corsHeaders);
    }

    // =================================================================================
    // 2. Registrar API (Domain Management)
    // =================================================================================

    /**
     * [GET] /api/domain/check
     * 特定のTLD配下のドメインが空いているか確認します。
     * TLDが非公開設定の場合や、既に取得されている場合はステータスを返します。
     */
    if (path === "/api/domain/check") {
      const name = url.searchParams.get("name");
      const tldName = url.searchParams.get("tld");

      if (!name || !tldName) return errorResponse("Missing name or tld parameters.", 400, corsHeaders);

      // TLD情報の取得 (公開設定と価格)
      const tldDb = await env.DB.prepare("SELECT is_public, price FROM tlds WHERE name=?").bind(tldName).first() as { is_public: number, price: number } | null;
      const tldEnv = env.CUSTOM_TLDS.split(',').includes(tldName);

      if (!tldDb && !tldEnv) {
        return jsonResponse({ status: "tld_not_found" }, 200, corsHeaders);
      }

      // デフォルト値 (System TLDの場合)
      const price = tldDb?.price || 0;
      const isPublic = tldDb ? (tldDb.is_public === 1) : true;

      // TLDが非公開なら登録不可
      if (!isPublic) {
        return jsonResponse({ status: "private" }, 200, corsHeaders);
      }

      // ドメイン名の重複チェック
      const exists = await env.DB.prepare("SELECT 1 FROM domains WHERE tld=? AND name=?").bind(tldName, name).first();
      
      return jsonResponse({ 
        status: exists ? "taken" : "available", 
        price: price 
      }, 200, corsHeaders);
    }

    /**
     * [POST] /api/domain/register
     * ドメインを実際に登録します。初期DNSレコード(Aレコード)も作成します。
     */
    if (path === "/api/domain/register" && request.method === "POST") {
      const body = await request.json() as any;
      const { name, tld, owner_id } = body;

      if (!name || !tld || !owner_id) return errorResponse("Missing required fields.", 400, corsHeaders);

      // ユーザー存在チェック
      const user = await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(owner_id).first();
      if (!user) return errorResponse("User not found.", 401, corsHeaders);

      // ドメインの重複チェック
      const check = await env.DB.prepare("SELECT 1 FROM domains WHERE tld=? AND name=?").bind(tld, name).first();
      if (check) return errorResponse("Domain is already taken.", 409, corsHeaders);

      // ドメイン作成
      const res = await env.DB.prepare(
        "INSERT INTO domains (tld, name, owner_id, created_at) VALUES (?, ?, ?, ?) RETURNING id"
      ).bind(tld, name, owner_id, Date.now()).first() as { id: number } | null;

      if (!res) return errorResponse("Failed to create domain.", 500, corsHeaders);

      // 初期DNSレコード (Aレコード @ 127.0.0.1) を自動作成
      await env.DB.prepare(
        "INSERT INTO records (domain_id, type, host, value, priority, ttl) VALUES (?, 'A', '@', '127.0.0.1', 0, 300)"
      ).bind(res.id).run();

      return jsonResponse({ success: true, message: "Domain registered successfully." }, 200, corsHeaders);
    }

    /**
     * [DELETE] /api/domain/delete
     * ドメインを削除します。紐づくレコードも削除されます。
     */
    if (path === "/api/domain/delete" && request.method === "DELETE") {
      const body = await request.json() as any;
      const { name, tld, owner_id } = body;
      
      const domain = await env.DB.prepare("SELECT id, owner_id FROM domains WHERE name=? AND tld=?").bind(name, tld).first() as { id: number, owner_id: string } | null;
      if (!domain || domain.owner_id !== owner_id) return errorResponse("Unauthorized or Not Found.", 403, corsHeaders);

      await env.DB.batch([
        env.DB.prepare("DELETE FROM records WHERE domain_id=?").bind(domain.id),
        env.DB.prepare("DELETE FROM domains WHERE id=?").bind(domain.id)
      ]);

      return jsonResponse({ success: true, message: "Domain deleted." }, 200, corsHeaders);
    }

    /**
     * [GET] /api/dashboard
     * ユーザーが所有するTLDとドメインの一覧を一括取得します。
     */
    if (path === "/api/dashboard") {
      const ownerId = url.searchParams.get("owner_id");
      if (!ownerId) return errorResponse("Missing owner_id parameter.", 400, corsHeaders);

      const user = await env.DB.prepare("SELECT username, tld_limit, created_at FROM users WHERE id=?").bind(ownerId).first();
      if (!user) return errorResponse("User not found.", 404, corsHeaders);

      const myTlds = await env.DB.prepare(
        "SELECT name, is_public, price, created_at FROM tlds WHERE owner_id=? ORDER BY created_at DESC"
      ).bind(ownerId).all();

      const myDomains = await env.DB.prepare(
        "SELECT id, tld, name, created_at FROM domains WHERE owner_id=? ORDER BY created_at DESC"
      ).bind(ownerId).all();

      return jsonResponse({
        user,
        tlds: myTlds.results,
        domains: myDomains.results
      }, 200, corsHeaders);
    }

    // =================================================================================
    // 3. DNS Record API (Advanced Management)
    // =================================================================================

    /**
     * [GET] /api/records
     * 特定ドメインのレコード一覧を取得します。
     */
    if (path === "/api/records") {
      const domainId = url.searchParams.get("domain_id");
      if (!domainId) return errorResponse("Missing domain_id parameter.", 400, corsHeaders);

      const { results } = await env.DB.prepare(
        "SELECT * FROM records WHERE domain_id=?"
      ).bind(domainId).all();

      return jsonResponse(results, 200, corsHeaders);
    }

    /**
     * [POST] /api/records/update
     * レコードの一括更新 (全削除 -> 再挿入 のトランザクション的処理)
     * 複雑なオブジェクト(SRV, HTTPSなど)はJSON文字列化して保存します。
     */
    if (path === "/api/records/update" && request.method === "POST") {
      const body = await request.json() as any;
      const { domain_id, owner_id, records } = body;

      if (!domain_id || !owner_id) return errorResponse("Missing required fields.", 400, corsHeaders);

      const domain = await env.DB.prepare("SELECT owner_id FROM domains WHERE id=?").bind(domain_id).first() as { owner_id: string } | null;
      if (!domain || domain.owner_id !== owner_id) {
        return errorResponse("Unauthorized: You do not own this domain.", 403, corsHeaders);
      }

      const batch = [];
      // 1. 既存レコードを全て削除
      batch.push(env.DB.prepare("DELETE FROM records WHERE domain_id=?").bind(domain_id));

      // 2. 新しいレコードを挿入
      if (Array.isArray(records)) {
        for (const r of records) {
          let valToStore = r.value;

          // オブジェクトデータはJSON文字列に変換
          if (typeof r.value === 'object' && r.value !== null) {
            valToStore = JSON.stringify(r.value);
          } else {
            valToStore = String(r.value);
          }

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

      await env.DB.batch(batch);
      return jsonResponse({ success: true, message: "DNS records updated." }, 200, corsHeaders);
    }

  } catch (e: any) {
    console.error("API Error:", e);
    return errorResponse(e.message || "Internal Server Error", 500, corsHeaders);
  }

  return errorResponse("API Endpoint Not Found", 404, corsHeaders);
}