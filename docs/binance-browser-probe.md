# Binance 365D browser verification

This is one manually authorized observation of Btc星辰, portfolio `4751838302089254401`, at the exact official Traditional Chinese URL:

https://www.binance.com/zh-TC/copy-trading/lead-details/4751838302089254401

The Microsoft Playwright skill is vendored under `.agents/skills/playwright-cli`, pinned at commit `c872a33cec77fa03c28fa7c6d1ad99d15d04ce42`. The runtime is `@playwright/cli@0.1.25`. No paid service is used.

## Run

Run the GitHub Actions workflow **Probe Binance 365D in normal Chromium** once with `workflow_dispatch`. It installs the pinned CLI and matching Chromium, runs offline tests, then opens a fresh headed browser under Xvfb. There is no scheduled trigger or persistent polling.

For offline validation only:

```sh
node --test audit/binance-playwright-probe-unit.cjs
```

For the explicit manual Linux browser observation, after installing the pinned CLI and browser:

```sh
CI=true NO_UPDATE_NOTIFIER=1 PLAYWRIGHT_CLI_BIN=/absolute/path/to/playwright-cli \
  xvfb-run -a node scripts/probe_binance_playwright.cjs --output-dir /empty/output/directory
```

## Evidence and stop conditions

The script initiates one document navigation, verifies the visible name and exact URL, and clicks the visible 365D control. It observes only requests naturally made by that page. It does not replay API endpoints, load a login session, solve challenges, change IP, spoof fingerprints, or retry refused requests.

HTTP 401/403/418/429/451 or an explicit WAF challenge closes the browser and stops. Empty HTTP 202 is recorded separately as unproven. A changed or redirected document URL stops rather than silently using another locale. No automatic rerun is configured.

Only allowlisted public observation fields and an optional public-page screenshot are retained. No cookies, profiles, storage state, full headers, HAR, trace, or arbitrary CLI logs are uploaded. The isolated session directory is removed after closing the browser.

`result.json` separates observation time, source time, original curve timestamps, and archived receipt time. A changed 365D ROI accompanied by new timestamped curve points may establish a new page observation while the ROI source timestamp remains unknown; this is recorded separately as `success_observed_changed` and requires review before publication. A successful CLI installation, an HTTP 200, a newly generated receipt, or chart pixels alone cannot prove new original data.

## Publication boundary

This task never writes `trader/` data, changes legacy source holds, resumes legacy collectors, or deploys the site. Failure leaves missing values empty. Real changed metrics bound to the selected account and period, accompanied by new timestamped original curve points, are required before expanding capture to all Binance accounts. A separate synchronization step must preserve unknown source timestamps rather than fill them with observation times. A readable page alone does not establish a permitted collection frequency.
