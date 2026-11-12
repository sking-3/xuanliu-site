#!/usr/bin/env node
'use strict';
// Offline validation only. No network requests, exchange SDK or signing keys.
const fs=require('node:fs'),E=require('../../trader/paper-engine.js');
const file=process.argv[2];if(!file){console.error('Usage: node tools/paper_copy/check.cjs exported-paper-ledger.json');process.exitCode=2;}else{try{const bytes=fs.readFileSync(file);if(bytes.length>2500000)throw Error('ledger_too_large');const s=JSON.parse(bytes);E.reconcile(s);console.log(JSON.stringify({paperOnly:s.paperOnly,sourceKey:s.sourceKey,method:s.method,orders:s.orders.length,simulated:s.orders.filter(o=>o.status!=='skipped').length,skipped:s.orders.filter(o=>o.status==='skipped').length,cashReconciled:true,positionsReconciled:true},null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
