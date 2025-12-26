import { Env } from './types';
import { handleDoH } from './handlers/doh';
import { handleApi } from './handlers/api';
import { handleAuth } from './handlers/auth';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-owner-id",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 1. Auth Endpoint
      if (url.pathname.startsWith("/api/auth")) {
        return await handleAuth(url, request, env, corsHeaders);
      }

      // 2. DoH Endpoint
      if (url.pathname.startsWith("/dns-query")) {
        const parts = url.pathname.split('/');
        const provider = parts[2] || 'google';
        return await handleDoH(request, env, corsHeaders, provider);
      }

      // 3. API Endpoint
      if (url.pathname.startsWith("/api")) {
        return await handleApi(url, request, env, corsHeaders);
      }

      if (url.pathname === "/") {
        return new Response("Root DNS Backend Active.", { headers: corsHeaders });
      }

      return new Response("Not Found", { status: 404, headers: corsHeaders });

    } catch (e: any) {
      return new Response(JSON.stringify({ error: "Internal Server Error", details: e.message }), { 
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }
  }
};