'use strict';
// All market traffic in these checks is intercepted; this never collects sources.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function run(program,args,extra={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(program,args,{cwd:root,stdio:'inherit',env:{...process.env,...extra}});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(program+' failed: '+code)));
  });
}
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
async function main() {
  const live=process.argv.includes('--live');
  if(!live&&!process.argv.includes('--browser-only')){
    const tests=fs.readdirSync(path.join(root,'audit')).filter(x=>/-unit\.(cjs|mjs)$/.test(x)).sort().map(x=>'audit/'+x);
    tests.push('quant-research/collect-public.test.mjs','quant-research/engine.test.mjs');
    await run(process.execPath,['--test',...tests]);
    await run(process.env.PYTHON||'python3',['-B','audit/site-static.py']);
  }else if(live){
    await run(process.execPath,['scripts/check_published_release.cjs']);
  }
  let server;
  try{
    let base=process.env.RELEASE_BASE_URL;
    if(!live){
      server=http.createServer((req,res)=>{
        try{
          const url=new URL(req.url,'http://localhost');
          let rel=decodeURIComponent(url.pathname).replace(/^\/+/, '');
          if(rel.split('/').some(x=>x.startsWith('.')||['private-follow','copy-config'].includes(x)))throw Error('private');
          let file=path.resolve(root,rel||'index.html');
          if(!file.startsWith(root+path.sep))throw Error('outside');
          if(fs.statSync(file).isDirectory())file=path.join(file,'index.html');
          res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
        }catch{res.writeHead(404);res.end('Not found');}
      });
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      base='http://127.0.0.1:'+server.address().port+'/';
    }
    for(const engine of (process.env.RELEASE_BROWSERS||'chromium,webkit').split(',')){
      if(!['chromium','webkit'].includes(engine))throw Error('Unsupported browser');
      const extra={RELEASE_BASE_URL:base,RELEASE_BROWSER:engine};
      await run(process.execPath,['audit/release-browser.cjs'],extra);
      await run(process.execPath,['audit/selection-release-browser.cjs'],extra);
    }
  }finally{if(server)await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
