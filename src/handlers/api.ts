import { Env } from '../types';
import { jsonResponse, errorResponse } from '../utils';

// ★ ローカルのJSONファイルからICANNリストを読み込み (高速化)
// ※ src/handlers/tlds.json が必要です
import icannTlds from './tlds.json';
const RESERVED_ICANN_TLDS = new Set(icannTlds);

// ★ 絶対権限を持つ管理者ID (adminユーザー)
const FIXED_ADMIN_ID = "058779fb-989a-4b0e-a26d-b21d3bf1c238";

export async function handleApi(url: URL, request: Request, env: Env, corsHeaders: any): Promise<Response> {
  const path = url.pathname;

  try {
    // =================================================================================
    // 1. Registry API (Root TLD Management)
    // =================================================================================

    /**
     * [GET] /api/tlds
     * 登録されている全てのTLDと、システム予約TLDをマージして返します。
     */
    if (path === "/api/tlds") {
      // DBからユーザー登録TLDを取得 (価格カラムなし)
      const { results } = await env.DB.prepare(
        "SELECT name, owner_id, is_public FROM tlds"
      ).all();

      // 環境変数からシステム予約TLDを取得
      const envTlds = env.CUSTOM_TLDS ? env.CUSTOM_TLDS.split(',') : [];
      
      const dbTlds = results || [];
      const allTlds = [...dbTlds];

      // システムTLDがDBに存在しない場合、リストに追加して表示する
      envTlds.forEach(t => {
        const trimmedTld = t.trim();
        if (trimmedTld && !dbTlds.find((dt: any) => dt.name === trimmedTld)) {
          allTlds.push({
            name: trimmedTld,
            is_public: 1, // システムTLDはデフォルトで公開
            owner_id: 'SYSTEM'
          });
        }
      });

      return jsonResponse(allTlds, 200, corsHeaders);
    }

    /**
     * [POST] /api/tld/register
     * 新しいRoot TLDを登録します。
     * - 入力値の詳細バリデーション
     * - ICANN予約語チェック (Adminは無視可能)
     * - ユーザーごとのTLD所有上限チェック (Adminは無視可能)
     */
    if (path === "/api/tld/register" && request.method === "POST") {
      const { name, owner_id } = await request.json() as any;

      // 1. 入力バリデーション
      if (!name || typeof name !== 'string') {
        return errorResponse("Invalid TLD name provided.", 400, corsHeaders);
      }
      if (!owner_id) {
        return errorResponse("Authentication required (owner_id missing).", 401, corsHeaders);
      }

      const lowerName = name.toLowerCase().trim();

      // 2. フォーマットチェック
      if (lowerName.includes('.')) return errorResponse("Root TLD cannot contain dots.", 400, corsHeaders);
      if (lowerName.length < 2) return errorResponse("TLD is too short (min 2 chars).", 400, corsHeaders);
      if (lowerName.length > 63) return errorResponse("TLD is too long (max 63 chars).", 400, corsHeaders);
      if (!/^[a-z0-9-]+$/.test(lowerName)) return errorResponse("TLD contains invalid characters.", 400, corsHeaders);

      // 3. 一般ユーザー向けの制限チェック (Adminはスキップ)
      if (owner_id !== FIXED_ADMIN_ID) {
        // ICANNチェック
        if (RESERVED_ICANN_TLDS.has(lowerName)) {
          return errorResponse(`'.${lowerName}' is reserved by ICANN/IANA and cannot be registered.`, 403, corsHeaders);
        }

        // ユーザー情報の取得
        const user = await env.DB.prepare("SELECT tld_limit FROM users WHERE id = ?").bind(owner_id).first() as { tld_limit: number } | null;
        if (!user) {
          return errorResponse("User not found. Please login again.", 401, corsHeaders);
        }

        // 現在のTLD所有数を確認
        const countRes = await env.DB.prepare("SELECT COUNT(*) as count FROM tlds WHERE owner_id = ?").bind(owner_id).first() as { count: number } | null;
        const currentCount = countRes?.count || 0;
        const limit = user.tld_limit || 10;

        if (currentCount >= limit) {
          return errorResponse(`TLD Limit Reached. You can only own ${limit} TLDs on your current plan.`, 403, corsHeaders);
        }
      }

      // 4. 重複チェック
      const exists = await env.DB.prepare("SELECT 1 FROM tlds WHERE name=?").bind(lowerName).first();
      const isSystem = env.CUSTOM_TLDS.split(',').includes(lowerName);

      // 既に存在する場合 (Admin以外はエラー)
      if ((exists || isSystem) && owner_id !== FIXED_ADMIN_ID) {
        return errorResponse(`TLD '.${lowerName}' is already taken.`, 409, corsHeaders);
      }

      // 5. 登録実行
      // Adminの場合は上書き(REPLACE)になる可能性があるため INSERT OR REPLACE を使用
      await env.DB.prepare(
        "INSERT OR REPLACE INTO tlds (name, owner_id, is_public, created_at, config) VALUES (?, ?, 0, ?, '{}')"
      ).bind(lowerName, owner_id, Date.now()).run();

      return jsonResponse({ success: true, message: `.${lowerName} has been successfully registered.` }, 200, corsHeaders);
    }

    /**
     * [POST] /api/tld/update
     * TLDの設定（公開/非公開、Config）を更新します。
     * ★ Admin特権: 他人のTLD設定も変更可能。
     */
    if (path === "/api/tld/update" && request.method === "POST") {
      const { name, owner_id, is_public, config } = await request.json() as any;

      if (!name || !owner_id) return errorResponse("Missing required fields.", 400, corsHeaders);

      // 所有権チェック
      const tld = await env.DB.prepare("SELECT owner_id FROM tlds WHERE name=?").bind(name).first() as { owner_id: string } | null;
      
      if (!tld) return errorResponse("TLD not found.", 404, corsHeaders);
      
      // 権限チェック (Admin or Owner)
      if (tld.owner_id !== owner_id && owner_id !== FIXED_ADMIN_ID) {
        return errorResponse("Unauthorized: You do not own this TLD.", 403, corsHeaders);
      }

      // 更新実行
      await env.DB.prepare(
        "UPDATE tlds SET is_public=?, config=? WHERE name=?"
      ).bind(
        is_public ? 1 : 0,
        JSON.stringify(config || {}),
        name
      ).run();

      return jsonResponse({ success: true, message: "TLD settings updated." }, 200, corsHeaders);
    }

    /**
     * [DELETE] /api/tld/delete
     * TLDを削除します。
     * ★ Admin特権: 他人のTLDも強制削除可能。
     * 関連する全てのドメインとレコードもカスケード削除します。
     */
    if (path === "/api/tld/delete" && request.method === "DELETE") {
      const { name, owner_id } = await request.json() as any;

      const tld = await env.DB.prepare("SELECT owner_id FROM tlds WHERE name=?").bind(name).first() as { owner_id: string } | null;
      
      if (!tld) return errorResponse("TLD not found.", 404, corsHeaders);
      
      // 権限チェック (Admin or Owner)
      if (tld.owner_id !== owner_id && owner_id !== FIXED_ADMIN_ID) {
        return errorResponse("Unauthorized: You cannot delete this TLD.", 403, corsHeaders);
      }

      // 削除バッチ処理 (Record -> Domain -> TLD の順で削除)
      await env.DB.batch([
        // 1. このTLD配下のドメインに紐づくレコードを削除
        env.DB.prepare("DELETE FROM records WHERE domain_id IN (SELECT id FROM domains WHERE tld=?)").bind(name),
        // 2. このTLD配下のドメインを削除
        env.DB.prepare("DELETE FROM domains WHERE tld=?").bind(name),
        // 3. TLD自体を削除
        env.DB.prepare("DELETE FROM tlds WHERE name=?").bind(name)
      ]);

      return jsonResponse({ success: true, message: `TLD .${name} and all associated domains deleted.` }, 200, corsHeaders);
    }

    // =================================================================================
    // 2. Registrar API (Domain Management)
    // =================================================================================

    /**
     * [GET] /api/domain/check
     * ドメインの空き状況を確認します。
     * TLDが非公開設定の場合、一般ユーザーには「Private」を返します。
     */
    if (path === "/api/domain/check") {
      const name = url.searchParams.get("name");
      const tldName = url.searchParams.get("tld");

      if (!name || !tldName) return errorResponse("Missing name or tld parameters.", 400, corsHeaders);

      // TLD情報の取得
      const tldDb = await env.DB.prepare("SELECT is_public FROM tlds WHERE name=?").bind(tldName).first() as { is_public: number } | null;
      const tldEnv = env.CUSTOM_TLDS.split(',').includes(tldName);

      if (!tldDb && !tldEnv) {
        return jsonResponse({ status: "tld_not_found" }, 200, corsHeaders);
      }

      // 公開設定チェック
      const isPublic = tldDb ? (tldDb.is_public === 1) : true;
      
      // 非公開TLDの場合
      if (!isPublic) {
        return jsonResponse({ status: "private" }, 200, corsHeaders);
      }

      // ドメイン名の重複チェック
      const exists = await env.DB.prepare("SELECT 1 FROM domains WHERE tld=? AND name=?").bind(tldName, name).first();
      
      return jsonResponse({ 
        status: exists ? "taken" : "available",
        price: 0
      }, 200, corsHeaders);
    }

    /**
     * [POST] /api/domain/register
     * ドメインを登録します。初期DNSレコード(Aレコード)も自動作成します。
     */
    if (path === "/api/domain/register" && request.method === "POST") {
      const { name, tld, owner_id } = await request.json() as any;

      if (!name || !tld || !owner_id) return errorResponse("Missing required fields.", 400, corsHeaders);

      // ユーザー存在チェック
      const user = await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(owner_id).first();
      if (!user) return errorResponse("User not found.", 401, corsHeaders);

      // ドメインの重複チェック
      const check = await env.DB.prepare("SELECT 1 FROM domains WHERE tld=? AND name=?").bind(tld, name).first();
      
      // 既に存在する場合
      if (check) {
        // Adminなら「上書き登録」を許可するか？
        // ドメインの上書きはレコードIDの不整合を招くため、Adminでも一旦削除してから再登録を推奨。
        // ここでは通常通りエラーを返します。Adminは DELETE API を使ってください。
        return errorResponse("Domain is already taken.", 409, corsHeaders);
      }

      // ドメイン作成
      const res = await env.DB.prepare(
        "INSERT INTO domains (tld, name, owner_id, created_at) VALUES (?, ?, ?, ?) RETURNING id"
      ).bind(tld, name, owner_id, Date.now()).first() as { id: number } | null;

      if (!res) return errorResponse("Failed to create domain.", 500, corsHeaders);

      // 初期DNSレコード (A @ 127.0.0.1) を自動作成
      await env.DB.prepare(
        "INSERT INTO records (domain_id, type, host, value, priority, ttl) VALUES (?, 'A', '@', '127.0.0.1', 0, 300)"
      ).bind(res.id).run();

      return jsonResponse({ success: true, message: "Domain registered successfully." }, 200, corsHeaders);
    }

    /**
     * [DELETE] /api/domain/delete
     * ドメインを削除します。
     * ★ Admin特権: 他人のドメインも強制削除可能。
     */
    if (path === "/api/domain/delete" && request.method === "DELETE") {
      const { name, tld, owner_id } = await request.json() as any;
      
      const domain = await env.DB.prepare("SELECT id, owner_id FROM domains WHERE name=? AND tld=?").bind(name, tld).first() as { id: number, owner_id: string } | null;
      
      if (!domain) return errorResponse("Domain not found.", 404, corsHeaders);
      
      // 権限チェック (Admin or Owner)
      if (domain.owner_id !== owner_id && owner_id !== FIXED_ADMIN_ID) {
        return errorResponse("Unauthorized: You do not own this domain.", 403, corsHeaders);
      }

      // 削除実行
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

      // 所有TLD一覧
      const myTlds = await env.DB.prepare(
        "SELECT name, is_public, created_at FROM tlds WHERE owner_id=? ORDER BY created_at DESC"
      ).bind(ownerId).all();

      // 所有ドメイン一覧
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
     * ★ Admin特権: 他人のDNSレコードも書き換え可能。
     */
    if (path === "/api/records/update" && request.method === "POST") {
      const { domain_id, owner_id, records } = await request.json() as any;

      if (!domain_id || !owner_id) return errorResponse("Missing required fields.", 400, corsHeaders);

      const domain = await env.DB.prepare("SELECT owner_id FROM domains WHERE id=?").bind(domain_id).first() as { owner_id: string } | null;
      
      if (!domain) return errorResponse("Domain not found.", 404, corsHeaders);

      // 権限チェック (Admin or Owner)
      if (domain.owner_id !== owner_id && owner_id !== FIXED_ADMIN_ID) {
        return errorResponse("Unauthorized: You do not own this domain.", 403, corsHeaders);
      }

      const batch = [];
      // 1. 既存レコードを全て削除
      batch.push(env.DB.prepare("DELETE FROM records WHERE domain_id=?").bind(domain_id));

      // 2. 新しいレコードを挿入
      if (Array.isArray(records)) {
        for (const r of records) {
          let valToStore = r.value;

          // オブジェクトデータはJSON文字列に変換して保存
          if (typeof r.value === 'object' && r.value !== null) {
            valToStore = JSON.stringify(r.value);
          } else {
            valToStore = String(r.value);
          }

          // 空の値は保存しない
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
      return jsonResponse({ success: true, message: "DNS records updated successfully." }, 200, corsHeaders);
    }

    // =================================================================================
    // 4. Admin Exclusive API (Transfer Ownership)
    // =================================================================================

    /**
     * [POST] /api/admin/transfer
     * ドメインやTLDの所有権を強制的に移動させる、管理者専用API。
     */
    if (path === "/api/admin/transfer" && request.method === "POST") {
      const { target_type, name, tld, new_owner_username, admin_id } = await request.json() as any;

      // Adminチェック (必須)
      if (admin_id !== FIXED_ADMIN_ID) {
        return errorResponse("Admin privileges required.", 403, corsHeaders);
      }

      // 新しい所有者のIDを取得
      const newUser = await env.DB.prepare("SELECT id FROM users WHERE username=?").bind(new_owner_username).first() as { id: string } | null;
      if (!newUser) return errorResponse("New owner user not found.", 404, corsHeaders);

      if (target_type === 'tld') {
        const res = await env.DB.prepare("UPDATE tlds SET owner_id=? WHERE name=?").bind(newUser.id, name).run();
        if (res.meta.changes === 0) return errorResponse("TLD not found.", 404, corsHeaders);
      } else if (target_type === 'domain') {
        const res = await env.DB.prepare("UPDATE domains SET owner_id=? WHERE name=? AND tld=?").bind(newUser.id, name, tld).run();
        if (res.meta.changes === 0) return errorResponse("Domain not found.", 404, corsHeaders);
      } else {
        return errorResponse("Invalid target_type.", 400, corsHeaders);
      }

      return jsonResponse({ success: true, message: "Ownership transferred successfully." }, 200, corsHeaders);
    }

  } catch (e: any) {
    console.error("API Error:", e);
    return errorResponse(e.message || "Internal Server Error", 500, corsHeaders);
  }

  return errorResponse("API Endpoint Not Found", 404, corsHeaders);
}