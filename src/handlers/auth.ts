import { Env } from '../types';
import { hashPassword, jsonResponse, errorResponse } from '../utils';

const FIXED_ADMIN_ID = "058779fb-989a-4b0e-a26d-b21d3bf1c238";

export async function handleAuth(url: URL, request: Request, env: Env, corsHeaders: any): Promise<Response> {
  const path = url.pathname;
  
  // Register
  if (path === "/api/auth/register" && request.method === "POST") {
    try {
      const { username, password } = await request.json() as any;
      const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

      if (!username || !password) return errorResponse("Invalid input.", 400, corsHeaders);
      if (password.length < 6) return errorResponse("Password too short.", 400, corsHeaders);

      const ipCount = await env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE created_ip = ?").bind(ip).first() as { count: number };
      if (ipCount.count >= 10 && username !== 'admin') return errorResponse("Too many accounts.", 429, corsHeaders);

      const existing = await env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).first();
      if (existing) return errorResponse("Username taken.", 400, corsHeaders);

      const userId = (username === 'admin') ? FIXED_ADMIN_ID : crypto.randomUUID();
      const hash = await hashPassword(password);

      await env.DB.prepare("INSERT INTO users (id, username, password_hash, created_ip, created_at) VALUES (?, ?, ?, ?, ?)").bind(userId, username, hash, ip, Date.now()).run();

      return jsonResponse({ success: true, user_id: userId }, 200, corsHeaders);
    } catch (e: any) { return errorResponse(e.message, 500, corsHeaders); }
  }

  // Login
  if (path === "/api/auth/login" && request.method === "POST") {
    try {
      const { username, password } = await request.json() as any;
      const user = await env.DB.prepare("SELECT id, password_hash FROM users WHERE username = ?").bind(username).first() as { id: string, password_hash: string } | null;
      if (!user) return errorResponse("Invalid credentials.", 401, corsHeaders);

      const hash = await hashPassword(password);
      if (user.password_hash !== hash) return errorResponse("Invalid credentials.", 401, corsHeaders);

      return jsonResponse({ success: true, user_id: user.id }, 200, corsHeaders);
    } catch (e: any) { return errorResponse(e.message, 500, corsHeaders); }
  }

  // ★ [DELETE] アカウント削除 (退会)
  if (path === "/api/auth/delete" && request.method === "DELETE") {
    try {
      const { user_id, password } = await request.json() as any;
      
      // 本人確認 (パスワード再確認)
      const user = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(user_id).first() as { password_hash: string } | null;
      if (!user) return errorResponse("User not found.", 404, corsHeaders);

      const hash = await hashPassword(password);
      if (user.password_hash !== hash) return errorResponse("Incorrect password.", 401, corsHeaders);

      // お掃除 (関連データを全て削除)
      // 1. 所有ドメインのレコード削除
      await env.DB.prepare("DELETE FROM records WHERE domain_id IN (SELECT id FROM domains WHERE owner_id=?)").bind(user_id).run();
      // 2. 所有TLD配下のドメインのレコード削除
      await env.DB.prepare("DELETE FROM records WHERE domain_id IN (SELECT id FROM domains WHERE tld IN (SELECT name FROM tlds WHERE owner_id=?))").bind(user_id).run();
      // 3. 所有ドメイン削除
      await env.DB.prepare("DELETE FROM domains WHERE owner_id=?").bind(user_id).run();
      // 4. 所有TLD配下のドメイン削除
      await env.DB.prepare("DELETE FROM domains WHERE tld IN (SELECT name FROM tlds WHERE owner_id=?)").bind(user_id).run();
      // 5. 所有TLD削除
      await env.DB.prepare("DELETE FROM tlds WHERE owner_id=?").bind(user_id).run();
      // 6. ユーザー削除
      await env.DB.prepare("DELETE FROM users WHERE id=?").bind(user_id).run();

      return jsonResponse({ success: true, message: "Account and all data deleted." }, 200, corsHeaders);

    } catch (e: any) { return errorResponse(e.message, 500, corsHeaders); }
  }

  return errorResponse("Auth endpoint not found", 404, corsHeaders);
}