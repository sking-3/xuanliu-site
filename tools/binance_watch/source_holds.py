"""Local policy read before constructing a live transport or opening checkpoints."""
import json
from pathlib import Path

POLICY = Path(__file__).resolve().parents[2] / "scripts/source-holds.json"


def reason(operation):
    try:
        value = json.loads(POLICY.read_text())[operation]
    except (OSError, ValueError, TypeError, KeyError):
        return "source_policy_unverified"
    return None if value == "approved" else (value if isinstance(value, str) and value else "source_policy_unverified")
