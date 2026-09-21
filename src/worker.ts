export { RankingScanner } from './scanner';

async function authenticated(request: Request, env: Env): Promise<boolean> {
  if (!env.ADMIN_TOKEN) return false;
  const value = request.headers.get('Authorization')?.replace(/^Bearer /,'') ?? '';
  const hash = async (s:string) => new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
  const [a,b] = await Promise.all([hash(value),hash(env.ADMIN_TOKEN)]);
  return crypto.subtle.timingSafeEqual(a,b);
}
const headers = { 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer' };
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const scanner = env.SCANNER.getByName('mfl-global-scan');
    if (url.pathname==='/league-cup-strengths-data.json') {
      if (request.method==='OPTIONS') return new Response(null,{headers:{...headers,'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, HEAD, OPTIONS'}});
      if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405,headers});
      const snapshot = await scanner.snapshot();
      return new Response(request.method==='HEAD'?null:snapshot.body,{status:snapshot.status,headers:{...headers,'Access-Control-Allow-Origin':'*','Content-Type':'application/json; charset=utf-8'}});
    }
    if (url.pathname.startsWith('/api/')) {
      if (!await authenticated(request,env)) return Response.json({error:'Enter your dashboard access key'},{status:401,headers});
      if (url.pathname==='/api/status' && request.method==='GET') return Response.json(await scanner.status(),{headers});
      const action = url.pathname.match(/^\/api\/(start|pause|stop)$/)?.[1];
      if (action && request.method==='POST') {
        const origin=request.headers.get('Origin');
        if (origin && origin!==url.origin) return new Response('Invalid origin',{status:403,headers});
        return Response.json(await scanner.control(action),{headers});
      }
      return new Response('Not found',{status:404,headers});
    }
    const asset = await env.ASSETS.fetch(request);
    const secured = new Response(asset.body,asset);
    for(const [key,value] of Object.entries(headers)) secured.headers.set(key,value);
    secured.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return secured;
  },
  async scheduled(_event,env) { await env.SCANNER.getByName('mfl-global-scan').recover(); }
} satisfies ExportedHandler<Env>;
