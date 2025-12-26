import { Env } from './types';
import { handleDoH } from './handlers/doh';
import { handleApi } from './handlers/api';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // -----------------------------------------------------
    // 最強のCORS設定 (あらゆるアクセスを許可)
    // -----------------------------------------------------
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", // どのサイトからでもOK
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
      "Access-Control-Allow-Headers": "*", // どんなヘッダーでもOK
      "Access-Control-Max-Age": "86400",
    };

    // プリフライトリクエスト(OPTIONS)への即答
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      let response: Response;

      // 1. DNS over HTTPS (DoH)
      if (url.pathname.startsWith("/dns-query")) {
        const parts = url.pathname.split('/');
        const provider = parts[2] || 'google';
        response = await handleDoH(request, env, corsHeaders, provider);
      }
      // 2. API
      else if (url.pathname.startsWith("/api")) {
        response = await handleApi(url, request, env, corsHeaders);
      }
      // 3. ルート確認用
      else if (url.pathname === "/") {
        response = new Response("Root DNS Backend API Active.", { status: 200 });
      }
      // 4. その他
      else {
        response = new Response("Not Found", { status: 404 });
      }

      // レスポンスに必ずCORSヘッダーを付与して返す
      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newHeaders.set(key, value);
      });

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });

    } catch (e: any) {
      // エラー発生時もCORSヘッダーをつけて返す（これが重要）
      return new Response(JSON.stringify({ error: e.message, stack: e.stack }), { 
        status: 500, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }
  }
};
// update: buffer fix