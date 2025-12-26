import { Env } from '../types';
import { hashPassword, jsonResponse, errorResponse } from '../utils';

export async function handleAuth(url: URL, request: Request, env: Env, corsHeaders: any): Promise<Response> {
  const path = url.pathname;
  
  // ---------------------------------------------------------
  // ユーザー登録 (IP制限: 10アカウントまで)
  // ---------------------------------------------------------
  if (path === "/api/auth/register" && request.method === "POST") {
    try {
      const body = await request.json() as any;
      const { username, password } = body;
      const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

      if (!username || !password) return errorResponse("Username and password required.", 400, corsHeaders);
      if (password.length < 6) return errorResponse("Password must be at least 6 characters.", 400, corsHeaders);

      // 1. IP制限チェック
      const ipCount = await env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE created_ip = ?").bind(ip).first();
      // @ts-ignore
      if (ipCount && ipCount.count >= 10) {
        return errorResponse("Too many accounts created from this IP address.", 429, corsHeaders);
      }

      // 2. ユーザー名重複チェック
      const existing = await env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).first();
      if (existing) return errorResponse("Username is already taken.", 400, corsHeaders);

      // 3. アカウント作成
      const userId = crypto.randomUUID();
      const hash = await hashPassword(password);

      await env.DB.prepare(
        "INSERT INTO users (id, username, password_hash, created_ip, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(userId, username, hash, ip, Date.now()).run();

      return jsonResponse({ success: true, user_id: userId, message: "Account created successfully." }, 200, corsHeaders);

    } catch (e: any) {
      return errorResponse(e.message, 500, corsHeaders);
    }
  }

  // ---------------------------------------------------------
  // ログイン
  // ---------------------------------------------------------
  if (path === "/api/auth/login" && request.method === "POST") {
    try {
      const body = await request.json() as any;
      const { username, password } = body;
      
      const user = await env.DB.prepare("SELECT id, password_hash FROM users WHERE username = ?").bind(username).first();
      
      if (!user) return errorResponse("Invalid username or password.", 401, corsHeaders);

      const hash = await hashPassword(password);
      // @ts-ignore
      if (user.password_hash !== hash) {
        return errorResponse("Invalid username or password.", 401, corsHeaders);
      }

      // @ts-ignore
      return jsonResponse({ success: true, user_id: user.id }, 200, corsHeaders);

    } catch (e: any) {
      return errorResponse(e.message, 500, corsHeaders);
    }
  }

  return errorResponse("Auth endpoint not found", 404, corsHeaders);
}