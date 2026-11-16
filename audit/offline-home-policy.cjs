'use strict';
function loopbackSite(value) {
  const url=new URL(value);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/'||url.username||url.password||url.search||url.hash) {
    throw Error('Offline homepage tests require an explicit http://127.0.0.1:<port>/ server');
  }
  return url;
}
function localLink(value,site) {
  const url=new URL(value);
  if(url.origin!==loopbackSite(site.href).origin||url.username||url.password)throw Error('External link must not be requested');
  return url.href;
}
module.exports={loopbackSite,localLink};
