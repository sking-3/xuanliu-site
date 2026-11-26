import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore, start } from './observer.mjs';

// Single bounded, read-only public-source check. Never creates an order, never
// dispatches a successor, and never emits source records to CI artifacts.
export async function runSmoke({WebSocketImpl=globalThis.WebSocket, durationMs=20000, pollMs=250}={}) {
 const startedAt=Date.now(),deadline=startedAt+durationMs,store=openStore(':memory:');
 let app,summary,success=false;
 try {
  app=start({store,WebSocketImpl,log:()=>{},reconnect:false});
  await new Promise(resolve=>{
   const timer=setInterval(()=>{
    if(Date.now()>=deadline || app.status().hardStopped){clearInterval(timer);resolve();}
   },pollMs);
  });
  const state=app.status(),rows=store.all();
  const live=rows.filter(row=>row.kind==='stream').map(row=>JSON.parse(row.event_json));
  summary={schemaVersion:1,scope:'hyperliquid_public_user_fills_read_only',startedAt:new Date(startedAt).toISOString(),
   finishedAt:new Date().toISOString(),snapshotReceived:state.baseline,sourceStop:store.stopReason(),
   reconciliationRequired:state.reconciliationRequired,baselineRows:rows.filter(r=>r.kind==='initial_baseline').length,
   freshLiveEvents:live.filter(x=>x.lagMs>=0 && x.lagMs<=30000).length,
   sourceToObserverLagMs:live.length?live.map(x=>x.lagMs):[],ordersSent:0};
  success=state.baseline && !state.hardStopped;
 } catch (error) {
  summary={schemaVersion:1,scope:'hyperliquid_public_user_fills_read_only',startedAt:new Date(startedAt).toISOString(),
   finishedAt:new Date().toISOString(),snapshotReceived:false,error:String(error.message).slice(0,100),ordersSent:0};
 } finally {
  if(app)app.stop();store.close();
 }
 return {success,summary};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 const {success,summary}=await runSmoke(),output=JSON.stringify(summary,null,2)+'\n';
 if(process.env.HL_FOCUS_SMOKE_REPORT)writeFileSync(process.env.HL_FOCUS_SMOKE_REPORT,output,{mode:0o600});
 process.stdout.write(output);if(!success)process.exitCode=1;
}
