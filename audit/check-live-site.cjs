'use strict';
const crypto=require('node:crypto');
const base='https://sking-3.github.io/xuanliu-site/';
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
(async()=>{
 const report={at:new Date().toISOString(),checks:[]};
 let stopped=false;
 async function get(rel){
  if(stopped)throw Error('site response refusal; no further requests');
  const url=new URL(rel,base);
  const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000)});
  const body=await r.text();
  report.checks.push({path:rel,status:r.status,type:r.headers.get('content-type'),date:r.headers.get('date'),cache:r.headers.get('x-cache'),age:r.headers.get('age'),bytes:Buffer.byteLength(body),sha256:hash(body)});
  if([401,403,429].includes(r.status)){stopped=true;throw Error('Site refused '+r.status);}
  if(!r.ok)throw Error('Site HTTP '+r.status+' '+rel);
  return body;
 }
 try{
  const home=await get('');report.title=home.match(/<title>(.*?)<\/title>/)?.[1];report.hasBody=/<body/.test(home);
  report.htmlBytes=home.length;
  const manifest=JSON.parse(await get('release-manifest.json'));report.revision=manifest.revision;report.manifestKeys=Object.keys(manifest);
  const assets=[...home.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)].map(x=>x[1]).filter(p=>/\.js\?|\.css\?/.test(p)&&!/^https?:/.test(p));
  for(const p of [...new Set(assets)].slice(0,18))await get(p);
  report.assetsChecked=Math.min(18,new Set(assets).size);
  console.log('LIVE_SITE_AVAILABILITY',JSON.stringify(report));
 }catch(error){report.error=error.message;console.log('LIVE_SITE_AVAILABILITY',JSON.stringify(report));throw error;}
})().catch(error=>{console.error(error);process.exitCode=1;});
