'use strict';
// Explicit harness for retired controllers; never loaded or hidden in a site page.
module.exports=[
 {
  "tag": "section",
  "id": "trend-screen"
 },
 {
  "tag": "h3",
  "id": "trend-heading"
 },
 {
  "tag": "details",
  "id": "trend-research-view"
 },
 {
  "tag": "button",
  "data": {
   "trendMode": "consensus"
  }
 },
 {
  "tag": "button",
  "data": {
   "trendMode": "market"
  }
 },
 {
  "tag": "button",
  "data": {
   "trendMode": "strength"
  }
 },
 {
  "tag": "select",
  "id": "trend-pattern"
 },
 {
  "tag": "select",
  "id": "trend-lookback"
 },
 {
  "tag": "select",
  "id": "trend-display"
 },
 {
  "tag": "div",
  "id": "trend-direction-controls"
 },
 {
  "tag": "button",
  "data": {
   "trendDirection": "up"
  }
 },
 {
  "tag": "button",
  "data": {
   "trendDirection": "down"
  }
 },
 {
  "tag": "button",
  "data": {
   "trendDirection": "sideways"
  }
 },
 {
  "tag": "button",
  "data": {
   "trendDirection": "all"
  }
 },
 {
  "tag": "div",
  "id": "trend-consensus-controls"
 },
 {
  "tag": "input",
  "id": "trend-breadth"
 },
 {
  "tag": "input",
  "id": "trend-qualified-only"
 },
 {
  "tag": "input",
  "id": "trend-peer-enabled"
 },
 {
  "tag": "span",
  "id": "trend-peer-status"
 },
 {
  "tag": "p",
  "id": "trend-consensus-status"
 },
 {
  "tag": "p",
  "id": "trend-strategy-status"
 },
 {
  "tag": "details",
  "id": "trend-settings"
 },
 {
  "tag": "div",
  "id": "trend-direction-settings"
 },
 {
  "tag": "input",
  "data": {
   "trendDirectionRule": "minimumReturnPercent"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendDirectionRule": "maximumSidewaysRangePercent"
  }
 },
 {
  "tag": "div",
  "id": "trend-strength-controls"
 },
 {
  "tag": "input",
  "data": {
   "trendStrength": "crossWithinDays"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendStrength": "minReturn5"
  }
 },
 {
  "tag": "div",
  "id": "trend-peer-controls"
 },
 {
  "tag": "input",
  "data": {
   "trendPeer": "groupTopPercent"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendPeer": "minPeers"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendPeer": "minExcessReturn"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendPeer": "minRecentExcess"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendPeer": "minImprovement"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendPeer": "minDownsideExcess"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendPeer": "maxSupportDistance"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendPeer": "minResistanceSpace"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendPeer": "sectorTopPercent"
  }
 },
 {
  "tag": "input",
  "id": "trend-heat-enabled"
 },
 {
  "tag": "input",
  "data": {
   "trendLimit": "maxReturn20"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendLimit": "maxReturn60"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendLimit": "maxReturn5"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendLimit": "maxDeviation"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendLimit": "maxVolumeRatio"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendPatternParam": "nearPct"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendPatternParam": "rangePct"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendPatternParam": "crossWindow"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendPatternParam": "pullbackMinPct"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendPatternParam": "pullbackMaxPct"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendPatternParam": "volumeExpandRatio"
  }
 },
 {
  "tag": "input",
  "data": {
   "trendPatternParam": "volumeContractRatio"
  }
 },
 {
  "tag": "p",
  "id": "trend-settings-error"
 },
 {
  "tag": "button",
  "id": "trend-reset-settings"
 },
 {
  "tag": "section",
  "id": "pattern-regimes"
 },
 {
  "tag": "h4",
  "id": "pattern-regimes-heading"
 },
 {
  "tag": "button",
  "id": "pattern-regimes-clear"
 },
 {
  "tag": "p",
  "id": "pattern-regimes-status"
 },
 {
  "tag": "p",
  "id": "pattern-regimes-source"
 },
 {
  "tag": "div",
  "id": "pattern-regimes-options"
 },
 {
  "tag": "p",
  "id": "pattern-regimes-selection"
 },
 {
  "tag": "p",
  "id": "pattern-regimes-method"
 },
 {
  "tag": "div",
  "id": "pattern-regimes-records"
 },
 {
  "tag": "p",
  "id": "trend-scheme-status"
 },
 {
  "tag": "p",
  "id": "trend-scheme-source"
 },
 {
  "tag": "details",
  "id": "trend-scheme-review"
 },
 {
  "tag": "span",
  "id": "trend-scheme-run-summary"
 },
 {
  "tag": "select",
  "id": "trend-scheme-runs"
 },
 {
  "tag": "select",
  "id": "trend-scheme-change"
 },
 {
  "tag": "p",
  "id": "trend-scheme-run-status"
 },
 {
  "tag": "tbody",
  "id": "trend-scheme-records"
 },
 {
  "tag": "p",
  "id": "trend-status"
 },
 {
  "tag": "span",
  "id": "trend-count"
 },
 {
  "tag": "div",
  "id": "trend-results"
 },
 {
  "tag": "div",
  "id": "trend-pagination"
 },
 {
  "tag": "button",
  "id": "trend-prev"
 },
 {
  "tag": "span",
  "id": "trend-page"
 },
 {
  "tag": "button",
  "id": "trend-next"
 }
];
