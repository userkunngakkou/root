import { Env } from './types';
import { handleDoH } from './handlers/doh';
import { handleApi } from './handlers/api';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // -----------------------------------------------------
    // CORS設定 (フロントエンドからのアクセスを許可)
    // -----------------------------------------------------
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", // すべてのサイトから許可
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-owner-id",
    };

    // プリフライトリクエスト(OPTIONS)への応答
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 1. DNS over HTTPS (DoH) エンドポイント
      // 例: /dns-query または /dns-query/cf
      if (url.pathname.startsWith("/dns-query")) {
        const parts = url.pathname.split('/');
        const provider = parts[2] || 'google'; // デフォルトはGoogle
        return await handleDoH(request, env, corsHeaders, provider);
      }

      // 2. 管理用 API エンドポイント
      // 例: /api/dashboard, /api/register
      if (url.pathname.startsWith("/api")) {
        return await handleApi(url, request, env, corsHeaders);
      }

      // 3. 動作確認用ルート
      if (url.pathname === "/") {
        return new Response("Root DNS Backend API Active.", { headers: corsHeaders });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });

    } catch (e: any) {
      return new Response(JSON.stringify({ error: "Internal Server Error", details: e.message }), { 
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }
  }
};