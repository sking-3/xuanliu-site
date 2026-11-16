#!/usr/bin/env node
'use strict';
/* Optional one-account capture, using the same source-refusal guard. Scheduled
 * portfolio collection reuses its existing requests for strategy reports. */
const fs=require('node:fs/promises'),path=require('node:path');
const model=require('../trader/strategy-analytics.js');
async function main(args=process.argv.slice(2)){
 const [user,period='30D']=args;if(args.length>2||!/^0x[0-9a-f]{40}$/.test(user||'')||!Object.hasOwn(model.PERIODS,period))throw Error('usage: collect_strategy_analytics.cjs address [period]');
 await require('./hyperliquid_run_guard.cjs').checkCommitted();
 const client=model.create({fetch:globalThis.fetch});
 try{const report=await client.request(user,period),file=path.resolve(__dirname,'../trader/strategy',user,period+'.json');model.validate(report,user,period);await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(report)+'\n');await fs.rename(tmp,file);console.log(JSON.stringify({accountId:user,period,status:report.status,reason:report.reason,samples:report.points.length,cashflows:report.cashflows.length,summary:report.summary}));}finally{client.destroy();}
}
module.exports={main};if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
