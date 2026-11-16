'use strict';
// Retired: loading the whole homepage contacted real providers without consulting
// their persisted source-stop state. The previous implementation remains in Git.
// Neither main pushes nor manual dispatches may use this as a release gate.
if (require.main === module) {
  console.error('Live homepage provider probing is disabled. Run audit/home-dashboard-browser.cjs against a loopback server with offline fixtures. Actual source access needs a separate reviewed source policy.');
  process.exitCode = 1;
}
module.exports = {enabled:false};
