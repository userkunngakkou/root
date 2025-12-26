export async function hashPassword(password: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export const jsonResponse = (data: any, status = 200, headers: any = {}) => 
  new Response(JSON.stringify(data), { 
    status, 
    headers: { ...headers, "Content-Type": "application/json" } 
  });

export const errorResponse = (msg: string, status = 400, headers: any = {}) => 
  jsonResponse({ error: msg }, status, headers);